package com.raut.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.os.RemoteException
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import woyou.aidlservice.jiuiv5.ICallback
import woyou.aidlservice.jiuiv5.IWoyouService

/**
 * The Sunmi built-in thermal printer, over its AIDL service.
 *
 * Dart decides what a receipt says; this only knows how to put marks on paper.
 * Keeping the layout on the Dart side means the receipt can be previewed on
 * screen and printed from the same source, so what a rep sees is what the
 * customer is handed.
 *
 * Two things about this service are worth stating, because both fail quietly:
 *
 * `bindService` returns false rather than throwing when the printer service is
 * absent — on a plain phone, or on a Sunmi with the service stopped. Every
 * method here therefore reports availability rather than assuming it, and the
 * app degrades to "no printer" instead of hanging on a callback that will never
 * come.
 *
 * Sunmi's own callbacks fire on a binder thread, and `MethodChannel.Result`
 * must be answered on the main thread. Results are posted back rather than
 * replied to inline.
 */
class SunmiPrinter(private val context: Context) {

    companion object {
        const val CHANNEL = "co.ke.raut/printer"

        private const val SERVICE_PACKAGE = "woyou.aidlservice.jiuiv5"
        private const val SERVICE_ACTION = "woyou.aidlservice.jiuiv5.IWoyouService"
        private const val SERVICE_CLASS = "woyou.aidlservice.jiuiv5.WoyouService"

        // Sunmi alignment constants.
        private const val ALIGN_LEFT = 0
        private const val ALIGN_CENTER = 1
        private const val ALIGN_RIGHT = 2
    }

    private var service: IWoyouService? = null
    private var binding = false

    /** Callbacks we do not act on. Sunmi requires a non-null binder regardless. */
    private val noop = object : ICallback.Stub() {
        override fun onRunResult(isSuccess: Boolean) {}
        override fun onReturnString(result: String?) {}
        override fun onRaiseException(code: Int, msg: String?) {}
        override fun onPrintResult(code: Int, msg: String?) {}
    }

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = IWoyouService.Stub.asInterface(binder)
            binding = false
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            // The printer service can be restarted by the platform underneath
            // us. Dropping the reference means the next call rebinds rather
            // than throwing DeadObjectException at a counter.
            service = null
            binding = false
        }
    }

    fun connect() {
        if (service != null || binding) return
        val intent = Intent().apply {
            setPackage(SERVICE_PACKAGE)
            action = SERVICE_ACTION
            setClassName(SERVICE_PACKAGE, SERVICE_CLASS)
        }
        binding = try {
            context.bindService(intent, connection, Context.BIND_AUTO_CREATE)
        } catch (_: SecurityException) {
            false
        }
    }

    fun dispose() {
        if (service != null || binding) {
            try {
                context.unbindService(connection)
            } catch (_: IllegalArgumentException) {
                // Not bound. Nothing to release.
            }
        }
        service = null
        binding = false
    }

    fun handle(call: MethodCall, result: MethodChannel.Result) {
        // Every path answers exactly once. A Flutter Result that is never
        // completed leaves the Dart side awaiting forever, which at a till
        // looks identical to a crash.
        when (call.method) {
            "isAvailable" -> {
                connect()
                result.success(service != null)
            }

            "printerInfo" -> {
                val svc = service
                if (svc == null) {
                    connect()
                    result.success(null)
                    return
                }
                result.success(
                    try {
                        mapOf(
                            "serial" to svc.printerSerialNo,
                            "model" to svc.printerModal,
                            "version" to svc.printerVersion,
                        )
                    } catch (_: RemoteException) {
                        null
                    },
                )
            }

            "print" -> {
                val svc = service
                if (svc == null) {
                    connect()
                    result.error("NO_PRINTER", "No Sunmi printer service is bound", null)
                    return
                }

                @Suppress("UNCHECKED_CAST")
                val ops = call.argument<List<Map<String, Any?>>>("ops") ?: emptyList()

                try {
                    // Buffered, then committed in one go. Printing op by op
                    // lets the paper advance between them, so a receipt can be
                    // torn off half-written if the app is backgrounded mid-run.
                    svc.enterPrinterBuffer(true)
                    ops.forEach { op -> apply(svc, op) }
                    svc.exitPrinterBuffer(true)
                    result.success(true)
                } catch (e: RemoteException) {
                    // The service died mid-print. Drop it so the next attempt
                    // rebinds rather than reusing a dead binder.
                    service = null
                    result.error("PRINT_FAILED", e.message, null)
                }
            }

            else -> result.notImplemented()
        }
    }

    private fun apply(svc: IWoyouService, op: Map<String, Any?>) {
        when (op["type"] as? String) {
            "text" -> {
                svc.setAlignment(alignmentOf(op["align"] as? String), noop)
                val size = (op["size"] as? Number)?.toFloat() ?: 24f
                val bold = op["bold"] as? Boolean ?: false
                // Sunmi has no bold flag on printTextWithFont, so weight is
                // carried by the typeface name it accepts.
                svc.printTextWithFont(
                    (op["text"] as? String ?: "") + "\n",
                    if (bold) "gh" else null,
                    size,
                    noop,
                )
            }

            "columns" -> {
                @Suppress("UNCHECKED_CAST")
                val cols = (op["columns"] as? List<String>)?.toTypedArray() ?: return
                @Suppress("UNCHECKED_CAST")
                val widths = (op["widths"] as? List<Number>)?.map { it.toInt() }?.toIntArray()
                    ?: return
                @Suppress("UNCHECKED_CAST")
                val aligns = (op["aligns"] as? List<Number>)?.map { it.toInt() }?.toIntArray()
                    ?: IntArray(cols.size) { ALIGN_LEFT }
                svc.printColumnsText(cols, widths, aligns, noop)
            }

            "qr" -> {
                svc.setAlignment(ALIGN_CENTER, noop)
                // Module size 5 keeps a KRA verification URL scannable on 58mm
                // paper; larger overruns the width and prints a clipped code,
                // which scans as nothing.
                svc.printQRCode(
                    op["data"] as? String ?: "",
                    (op["size"] as? Number)?.toInt() ?: 5,
                    (op["errorLevel"] as? Number)?.toInt() ?: 2,
                    noop,
                )
                svc.setAlignment(ALIGN_LEFT, noop)
            }

            "barcode" -> {
                svc.setAlignment(ALIGN_CENTER, noop)
                svc.printBarCode(
                    op["data"] as? String ?: "",
                    (op["symbology"] as? Number)?.toInt() ?: 8,
                    (op["height"] as? Number)?.toInt() ?: 80,
                    (op["width"] as? Number)?.toInt() ?: 2,
                    (op["textPosition"] as? Number)?.toInt() ?: 2,
                    noop,
                )
                svc.setAlignment(ALIGN_LEFT, noop)
            }

            "feed" -> svc.lineWrap((op["lines"] as? Number)?.toInt() ?: 1, noop)
        }
    }

    private fun alignmentOf(value: String?): Int = when (value) {
        "center" -> ALIGN_CENTER
        "right" -> ALIGN_RIGHT
        else -> ALIGN_LEFT
    }
}
