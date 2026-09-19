# Capture one emulator screen.
#
# Via a file on the device rather than `exec-out ... > file`: PowerShell's
# redirect writes a BOM and re-encodes, which corrupts every PNG it touches.
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Serial = "emulator-5556",
    [int]$Wait = 2
)

$dir = Join-Path $PSScriptRoot "shots"
New-Item -ItemType Directory -Force -Path $dir | Out-Null

Start-Sleep -Seconds $Wait
& adb -s $Serial shell screencap -p /sdcard/_shot.png | Out-Null
& adb -s $Serial pull /sdcard/_shot.png (Join-Path $dir "$Name.png") 2>&1 | Out-Null
& adb -s $Serial shell rm -f /sdcard/_shot.png | Out-Null

$f = Get-Item (Join-Path $dir "$Name.png") -ErrorAction SilentlyContinue
if ($f) { Write-Output "$Name.png  $([math]::Round($f.Length/1KB))KB" }
else { Write-Output "$Name FAILED" }
