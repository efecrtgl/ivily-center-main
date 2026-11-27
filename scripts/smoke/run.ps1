# Real-app smoke tests (developer machine, Windows).
#
# Starts the Vite dev server, builds and runs the debug app with the WebView2 DevTools protocol
# enabled on a local port, runs the DevTools scripts in this folder against the live webview, and
# stops everything again. The app uses your normal data folder (%LOCALAPPDATA%\IvilyCenter).
#
#   powershell -ExecutionPolicy Bypass -File scripts/smoke/run.ps1
param([int]$Port = 9333)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Push-Location $root
$vite = $null; $app = $null
try {
  if (Get-NetTCPConnection -LocalPort 1460 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 1460 is in use; stop the running dev server first.' }
  $vite = Start-Process -FilePath 'npx.cmd' -ArgumentList 'vite', '--port', '1460', '--strictPort' -PassThru -WindowStyle Hidden
  Push-Location src-tauri; cargo build; Pop-Location
  $failed = $false
  foreach ($script in 'workbench.mjs', 'multi-window.mjs') {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
    $app = Start-Process -FilePath (Join-Path $root 'src-tauri\target\debug\ivily-center.exe') -PassThru
    Write-Host "== $script"
    $out = node (Join-Path $PSScriptRoot $script) $Port | Out-String
    Write-Host $out
    if ($out -match 'exception:|console\.error|NO_TARGET|"\w+Problems": \[\s*"') { $failed = $true }
    Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue; $app = $null
    Start-Sleep -Seconds 1
  }
  if ($failed) { Write-Error 'Smoke test found problems (see above).' } else { Write-Host 'Smoke tests passed.' }
} finally {
  if ($app) { Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue }
  $c = Get-NetTCPConnection -LocalPort 1460 -State Listen -ErrorAction SilentlyContinue
  if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
  Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  Pop-Location
}
