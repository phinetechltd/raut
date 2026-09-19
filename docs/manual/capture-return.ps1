# Walks the return flow end to end and captures each screen.
#
# Coordinates are for a 1080x2424 emulator. Kept in one script so a re-capture
# after a UI change is one command rather than thirty taps.
param([string]$Serial = "emulator-5556")

function Tap($x, $y, $pause = 2) {
    & adb -s $Serial shell input tap $x $y | Out-Null
    Start-Sleep -Seconds $pause
}
function Shot($name, $wait = 2) {
    & "$PSScriptRoot\shot.ps1" -Name $name -Serial $Serial -Wait $wait
}

# --- sign in -------------------------------------------------------------
& adb -s $Serial shell monkey -p com.raut.app -c android.intent.category.LAUNCHER 1 | Out-Null
Start-Sleep -Seconds 14
Shot "01-login" 1

Tap 538 1269 1
& adb -s $Serial shell input text "Raut@2026" | Out-Null
Start-Sleep -Seconds 1
# ENTER submits; tapping the button is unreliable because the keyboard covers it.
& adb -s $Serial shell input keyevent 66 | Out-Null
Start-Sleep -Seconds 25
Tap 538 1549 20        # allow location
Shot "02-route" 3

# --- the visit -----------------------------------------------------------
Tap 400 1485 5         # Rift Valley Distributors
Shot "03-visit" 2

# --- the filed tax invoice ----------------------------------------------
Tap 793 2082 5         # Payment
Tap 538 450 2          # tap the card to drop the keyboard
Shot "04-payment" 2
& adb -s $Serial shell input swipe 538 1900 538 1300 400 | Out-Null
Start-Sleep -Seconds 2
Tap 932 1994 6         # the filed invoice
Shot "05-receipt-filed" 2

# --- the return ----------------------------------------------------------
Tap 278 2246 5         # Return
Tap 941 547 1          # one dozen back
Tap 538 1077 1         # reason
& adb -s $Serial shell input text "Two%scartons%sleaked%sin%stransit" | Out-Null
Start-Sleep -Seconds 1
& adb -s $Serial shell input keyevent 4 | Out-Null   # closes the IME only
Start-Sleep -Seconds 2
Shot "06-return" 1

Tap 538 2246 18        # Credit
Shot "07-credit-note" 2

Write-Output "capture complete"
