# Drives the emulator through sign-in so the capture run starts from a known
# place. Kept as a script rather than ad-hoc taps: the coordinates are for a
# 1080x2424 screen and are worth writing down once.
param(
    [string]$Serial = "emulator-5556",
    [string]$Email = "rep@tarisolutions.co.ke",
    [string]$Password = "Raut@2026"
)

function Tap($x, $y, $pause = 2) {
    & adb -s $Serial shell input tap $x $y | Out-Null
    Start-Sleep -Seconds $pause
}

& adb -s $Serial shell monkey -p com.raut.app -c android.intent.category.LAUNCHER 1 | Out-Null
Start-Sleep -Seconds 12

# Email is prefilled with the demo rep; only the password is typed.
Tap 538 1269 1
& adb -s $Serial shell input text $Password | Out-Null
Start-Sleep -Seconds 1

# Dismiss the keyboard by tapping dead space, not BACK: BACK on this screen
# leaves the app entirely and the run silently continues against the launcher.
Tap 538 760 2
Tap 538 1475 20

# The location prompt appears on a fresh install.
Tap 538 1549 4

Write-Output "signed in; waiting for the first sync"
Start-Sleep -Seconds 20
