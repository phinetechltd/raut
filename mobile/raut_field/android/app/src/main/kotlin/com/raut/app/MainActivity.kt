package com.raut.app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {

    private var printer: SunmiPrinter? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        val sunmi = SunmiPrinter(applicationContext)
        printer = sunmi
        // Bound eagerly rather than on first print: binding takes a moment, and
        // the first receipt of the day is the one a rep is standing waiting for.
        sunmi.connect()

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, SunmiPrinter.CHANNEL)
            .setMethodCallHandler { call, result -> sunmi.handle(call, result) }
    }

    override fun onDestroy() {
        printer?.dispose()
        printer = null
        super.onDestroy()
    }
}
