# Raises one invoice that eTIMS will actually file, so the manual can show a
# real control code rather than a mocked-up one.
#
# The seeded invoices predate the eTIMS start date and are NOT_APPLICABLE — the
# server will never file them, which is correct and is exactly the state the
# receipt screen now refuses to wait on.

$base = "http://localhost:3200/api/v1"
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession

$login = Invoke-RestMethod -Uri "$base/auth/login" -Method Post -WebSession $session `
    -ContentType "application/json" `
    -Body (@{ email = "admin@zamarsolutions.co.ke"; password = "Raut@2026" } | ConvertTo-Json)

Write-Output "signed in as $($login.data.user.name)"

# The list endpoints return the array directly under `data`, not wrapped.
$customers = (Invoke-RestMethod -Uri "$base/customers?limit=100" -WebSession $session).data
$customer = $customers | Where-Object { $_.name -like "Rift Valley*" } | Select-Object -First 1
Write-Output "customer: $($customer.name)"

$products = (Invoke-RestMethod -Uri "$base/products?limit=100" -WebSession $session).data
$product = $products | Where-Object { $_.name -like "Cooking Oil 2L*" } | Select-Object -First 1
if (-not $product) { $product = $products | Select-Object -First 1 }
Write-Output "product: $($product.name)"

$variants = Invoke-RestMethod -Uri "$base/products/variants?productId=$($product.id)" -WebSession $session
$dozen = $variants.data.variants | Where-Object { $_.unitsPerVariant -gt 1 } | Select-Object -First 1
Write-Output "selling unit: $($dozen.name) x$($dozen.unitsPerVariant)"

$stock = Invoke-RestMethod -Uri "$base/stock" -WebSession $session
$location = $stock.data.locations | Where-Object { $_.type -eq "WAREHOUSE" } | Select-Object -First 1

$body = @{
    customerId = $customer.id
    issue      = $true
    locationId = $location.id
    clientUuid = [guid]::NewGuid().ToString()
    lines      = @(
        @{ productId = $product.id; variantId = $dozen.id; quantity = 2 },
        @{ productId = $product.id; quantity = 3 }
    )
} | ConvertTo-Json -Depth 5

$inv = Invoke-RestMethod -Uri "$base/invoices" -Method Post -WebSession $session `
    -ContentType "application/json" -Body $body

$id = if ($inv.data.invoice) { $inv.data.invoice.id } else { $inv.data.id }
$number = if ($inv.data.invoice) { $inv.data.invoice.number } else { $inv.data.number }
Write-Output "raised $number"

Start-Sleep -Seconds 3
$filed = Invoke-RestMethod -Uri "$base/invoices/$id" -WebSession $session
$i = $filed.data.invoice
Write-Output "  eTIMS       : $($i.etimsStatus)"
Write-Output "  control code: $($i.etimsControlCode)"
Write-Output "  KRA invoice : $($i.etimsInvoiceNumber)"
Write-Output "  total       : KES $([math]::Round($i.totalCents / 100, 2))"
Write-Output "  invoice id  : $id"
