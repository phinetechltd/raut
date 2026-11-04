# Confirms the return the app just raised was filed correctly, rather than
# trusting the green banner on the phone.
$base = "http://localhost:3200/api/v1"
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession

Invoke-RestMethod -Uri "$base/auth/login" -Method Post -WebSession $s `
    -ContentType "application/json" `
    -Body (@{ email = "admin@tarisolutions.co.ke"; password = "Raut@2026" } | ConvertTo-Json) | Out-Null

$notes = (Invoke-RestMethod -Uri "$base/credit-notes" -WebSession $s).data.rows
$note = $notes | Select-Object -First 1
Write-Output "credit note : $($note.number) against $($note.invoice.number)"
Write-Output "  status    : $($note.etimsStatus)"
Write-Output "  control   : $($note.etimsControlCode)"
Write-Output "  credited  : KES $([math]::Round($note.totalCents/100,2))"
Write-Output "  restock   : $($note.restock)"
foreach ($l in $note.lines) {
    Write-Output "  line      : $($l.description)  qty=$($l.quantity)  base=$($l.baseQuantity)"
}

$subs = (Invoke-RestMethod -Uri "$base/etims/submissions" -WebSession $s).data.rows
$filed = $subs | Where-Object { $_.docType -eq "CREDIT_NOTE" -and $_.docId -eq $note.id } | Select-Object -First 1
if ($filed) {
    $req = $filed.request | ConvertFrom-Json
    Write-Output ""
    Write-Output "filed with KRA:"
    Write-Output "  sale_id   : $($req.sale_id)"
    foreach ($i in $req.items) {
        Write-Output "  quantity  : $($i.quantity)   unit_price: $($i.unit_price)   total: $($i.total_amount)"
    }
}

$tb = (Invoke-RestMethod -Uri "$base/reports/trial-balance" -WebSession $s).data
Write-Output ""
Write-Output "books balanced: $($tb.balanced)   debits = credits = $($tb.debits)"
$returns = $tb.rows | Where-Object { $_.code -eq "4100" }
Write-Output "sales returns (4100) debit: KES $([math]::Round($returns.debitCents/100,2))"
