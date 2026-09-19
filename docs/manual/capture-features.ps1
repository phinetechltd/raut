# Captures the wider app: route, customers, ordering and payment options.
#
# Separate from capture-return.ps1 because it starts from a signed-in app and
# walks a different path; running them back to back re-signs-in needlessly.
param([string]$Serial = "emulator-5556")

function Tap($x, $y, $pause = 2) {
    & adb -s $Serial shell input tap $x $y | Out-Null
    Start-Sleep -Seconds $pause
}
function Shot($name, $wait = 2) {
    & "$PSScriptRoot\shot.ps1" -Name $name -Serial $Serial -Wait $wait
}
function Back($pause = 2) {
    & adb -s $Serial shell input keyevent 4 | Out-Null
    Start-Sleep -Seconds $pause
}

& adb -s $Serial shell monkey -p com.raut.app -c android.intent.category.LAUNCHER 1 | Out-Null
Start-Sleep -Seconds 12

# --- customers -----------------------------------------------------------
Tap 403 2270 4          # Customers tab
Shot "11-customers" 2

Tap 400 1749 5          # open a customer (starts or resumes a visit)
Shot "12-customer" 2

# --- ordering, with selling units ---------------------------------------
Tap 283 2082 6          # Order
Shot "13-order" 2
Tap 449 1544 2          # switch a product to Dozen
Tap 972 1480 2          # add one
Shot "14-order-units" 2

Back 3                  # out of the order screen

# --- payment options -----------------------------------------------------
Tap 793 2082 5          # Payment
Tap 538 450 2           # tap the card to drop the keyboard
Shot "15-payment-methods" 2

Write-Output "feature capture complete"
