package woyou.aidlservice.jiuiv5;

import woyou.aidlservice.jiuiv5.ICallback;

// The subset of Sunmi's printer service this app uses. The real interface is
// much larger; declaring only what is called keeps the surface honest and the
// binder signature still matches, because AIDL dispatches by method order —
// which is exactly why the order below must not be changed.
interface IWoyouService {
    void printerInit(in ICallback callback);
    void printerSelfChecking(in ICallback callback);
    String getPrinterSerialNo();
    String getPrinterModal();
    String getPrinterVersion();
    void updatePrinterState();
    void printerDeviceUpdate(in String data);
    void setPrinterStyle(int key, int value);
    void getPrintedLength(in ICallback callback);
    void lineWrap(int n, in ICallback callback);
    void sendRAWData(in byte[] data, in ICallback callback);
    void setAlignment(int alignment, in ICallback callback);
    void setFontName(String typeface, in ICallback callback);
    void setFontSize(float fontsize, in ICallback callback);
    void printText(String text, in ICallback callback);
    void printTextWithFont(String text, String typeface, float fontsize, in ICallback callback);
    void printColumnsText(in String[] colsTextArr, in int[] colsWidthArr, in int[] colsAlign, in ICallback callback);
    void printBitmap(in android.graphics.Bitmap bitmap, in ICallback callback);
    void printBarCode(String data, int symbology, int height, int width, int textposition, in ICallback callback);
    void printQRCode(String data, int modulesize, int errorlevel, in ICallback callback);
    void printOriginalText(String text, in ICallback callback);
    void commitPrint(in android.graphics.Bitmap[] bitmaps, in ICallback callback);
    void commitPrinterBuffer();
    void enterPrinterBuffer(boolean clean);
    void exitPrinterBuffer(boolean commit);
}
