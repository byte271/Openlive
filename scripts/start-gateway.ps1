# Start OpenLive gateway on 127.0.0.1:12345
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$exe = Join-Path $root "target\release\openlive-gateway.exe"
if (-not (Test-Path $exe)) {
  Write-Host "Building openlive-gateway (release)..."
  cargo build -p openlive-gateway --release
}
Get-Process openlive-gateway -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath $exe -ArgumentList "--listen","127.0.0.1:12345","--web-dir","apps/openlive-gateway/web" -WorkingDirectory $root
Start-Sleep 2
try {
  $h = Invoke-WebRequest "http://127.0.0.1:12345/health" -UseBasicParsing -TimeoutSec 5
  Write-Host "Gateway OK: http://127.0.0.1:12345  (status $($h.StatusCode))"
} catch {
  Write-Host "Gateway may still be starting. Open http://127.0.0.1:12345"
}
