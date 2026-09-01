package woyou.aidlservice.jiuiv5;

// Sunmi's printer callback. Declared here rather than pulled from a jar so the
// build has no binary dependency on a vendor SDK we cannot vendor into git.
interface ICallback {
    void onRunResult(boolean isSuccess);
    void onReturnString(String result);
    void onRaiseException(int code, String msg);
    void onPrintResult(int code, String msg);
}
