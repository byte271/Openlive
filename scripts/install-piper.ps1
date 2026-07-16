# OpenLive · install open-source Piper TTS (Windows)
# powershell -ExecutionPolicy Bypass -File scripts\install-piper.ps1

$ErrorActionPreference = "Stop"
$dir = Join-Path $env:LOCALAPPDATA "openlive\piper"
$binDir = Join-Path $dir "piper"
$modelsDir = Join-Path $dir "models"
New-Item -ItemType Directory -Force -Path $binDir, $modelsDir | Out-Null

$zip = Join-Path $dir "piper-windows.zip"
Write-Host "Downloading Piper binary..."
Invoke-WebRequest -Uri "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip" -OutFile $zip

$extract = Join-Path $dir "_extract"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
New-Item -ItemType Directory -Force -Path $extract | Out-Null
Expand-Archive -Path $zip -DestinationPath $extract -Force

# Zip nests as piper/piper.exe + DLLs (or deeper). Find the real exe next to onnxruntime.dll.
$exe = Get-ChildItem -Path $extract -Recurse -Filter "piper.exe" -ErrorAction SilentlyContinue |
  Where-Object {
    Test-Path (Join-Path $_.DirectoryName "onnxruntime.dll") -or
    Test-Path (Join-Path $_.DirectoryName "espeak-ng.dll")
  } |
  Select-Object -First 1

if (-not $exe) {
  $exe = Get-ChildItem -Path $extract -Recurse -Filter "piper.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
}
if (-not $exe) { throw "piper.exe not found after extract" }

# Flatten: copy the whole folder that contains piper.exe into $binDir
$srcDir = $exe.DirectoryName
Write-Host "Flattening Piper runtime from: $srcDir"
Get-ChildItem -Path $srcDir -Force | ForEach-Object {
  $dest = Join-Path $binDir $_.Name
  if ($_.PSIsContainer) {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $_.FullName $dest -Recurse -Force
  } else {
    Copy-Item $_.FullName $dest -Force
  }
}

$targetExe = Join-Path $binDir "piper.exe"
if (-not (Test-Path $targetExe)) { throw "piper.exe missing at $targetExe after flatten" }

# Clean extract staging
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue

$model = Join-Path $modelsDir "en_US-lessac-medium.onnx"
$cfg = "$model.json"
Write-Host "Downloading voice model (en_US-lessac-medium)..."
if (-not (Test-Path $model) -or (Get-Item $model).Length -lt 1MB) {
  Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx" -OutFile $model
}
if (-not (Test-Path $cfg)) {
  Invoke-WebRequest -Uri "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json" -OutFile $cfg
}

# Smoke-test synthesis (ensures DLLs resolve)
$testWav = Join-Path $dir "install-smoke.wav"
Write-Host "Smoke-testing Piper..."
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $targetExe
$psi.Arguments = "--model `"$model`" --output_file `"$testWav`""
$psi.WorkingDirectory = $binDir
$psi.RedirectStandardInput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.WriteLine("OpenLive voice ready.")
$proc.StandardInput.Close()
$proc.WaitForExit(60000) | Out-Null
$err = $proc.StandardError.ReadToEnd()
if ($proc.ExitCode -ne 0 -or -not (Test-Path $testWav)) {
  Write-Warning "Piper smoke test failed (exit $($proc.ExitCode)): $err"
  Write-Host "Binary is at $targetExe — ensure DLLs sit next to it."
} else {
  Write-Host "Smoke test OK ($((Get-Item $testWav).Length) bytes wav)."
  Remove-Item $testWav -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "Installed."
Write-Host "  Binary: $targetExe"
Write-Host "  Model:  $model"
Write-Host "Restart openlive-gateway, then Settings → TTS engine → Auto or Piper."
