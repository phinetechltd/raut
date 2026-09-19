# Captures the screens the first two runs missed: the day summary, the sync
# queue and an expense claim.
param([string]$Serial = "emulator-5554")

function Tap($x, $y, $pause = 2) {
    & adb -s $Serial shell input tap $x $y | Out-Null
    Start-Sleep -Seconds $pause
}
function Shot($name, $wait = 2) {
    & "$PSScriptRoot\shot.ps1" -Name $name -Serial $Serial -Wait $wait
}

& adb -s $Serial shell am force-stop com.raut.app | Out-Null
Start-Sleep -Seconds 2
& adb -s $Serial shell monkey -p com.raut.app -c android.intent.category.LAUNCHER 1 | Out-Null
Start-Sleep -Seconds 16

Tap 538 1269 2
& adb -s $Serial shell input text "Raut@2026" | Out-Null
Start-Sleep -Seconds 2
& adb -s $Serial shell input keyevent 66 | Out-Null   # Enter submits
Start-Sleep -Seconds 28
Tap 538 1549 24        # allow location

Tap 673 2270 5         # Today tab
Shot "16-today" 2

Tap 944 2270 5         # More tab
Shot "17-more-full" 2

Tap 538 800 5          # Sync queue
Shot "18-sync-queue" 2

& adb -s $Serial shell input keyevent 4 | Out-Null
Start-Sleep -Seconds 3
Tap 538 1180 5         # Expense claim
Shot "19-expense" 2

Write-Output "done"
