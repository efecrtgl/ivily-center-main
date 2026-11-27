# Install / uninstall check of the NSIS installer.
#
# Meant for a clean machine (e.g. the GitHub Actions Windows runner). Installs silently, checks the
# version, the uninstall registry entry and the Start menu shortcut, runs the installed app with
# `--iep describe` (no window, no database created), uninstalls silently and checks that program
# files, shortcut and registry entry are gone while user data is kept.
#
# WARNING: do not run this on a machine where Ivily Center is installed — it replaces and removes it.
#
# Usage: ./scripts/test-installer.ps1 -Installer "Ivily Center_0.1.0_x64-setup.exe" -ExpectedVersion 0.1.0
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion
)
$ErrorActionPreference = "Stop"
$appDir = Join-Path $env:LOCALAPPDATA "Ivily Center"
$exe = Join-Path $appDir "ivily-center.exe"
$dataDir = Join-Path $env:LOCALAPPDATA "IvilyCenter"
$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Ivily Center"
$shortcut = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\Ivily Center\Ivily Center.lnk"

function Fail($msg) { Write-Error $msg; exit 1 }
function Wait-Until([scriptblock]$cond, [int]$seconds, [string]$what) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while (-not (& $cond)) {
    if ((Get-Date) -gt $deadline) { Fail "Timed out waiting for: $what" }
    Start-Sleep -Milliseconds 500
  }
}

if (Test-Path $regPath) { Fail "Ivily Center is already installed; run this only on a clean machine." }
$dataExisted = Test-Path $dataDir

# --- Install ----------------------------------------------------------------------------------
$installerPath = (Resolve-Path $Installer).Path
$p = Start-Process -FilePath $installerPath -ArgumentList "/S" -PassThru -Wait
if ($p.ExitCode -ne 0) { Fail "Installer exit code $($p.ExitCode)" }
Wait-Until { Test-Path $exe } 60 "the program file"
# The installer may start the app afterwards; it must not affect the test.
Start-Sleep -Seconds 2
Get-Process ivily-center -ErrorAction SilentlyContinue | Stop-Process -Force

$reg = Get-ItemProperty $regPath
if ($reg.DisplayVersion -ne $ExpectedVersion) { Fail "Registry version $($reg.DisplayVersion), expected $ExpectedVersion" }
$fileVersion = (Get-Item $exe).VersionInfo.ProductVersion
if (-not $fileVersion.StartsWith($ExpectedVersion.Split('-')[0])) { Fail "App version $fileVersion, expected $ExpectedVersion" }
if (-not (Test-Path $shortcut)) { Fail "Start menu shortcut was not created" }
Write-Host "Install: ok (version $ExpectedVersion, $($reg.InstallLocation))"

# --- Run the installed app without a window ---------------------------------------------------
$json = & $exe --iep describe | Out-String
if ($LASTEXITCODE -ne 0) { Fail "--iep describe exit code $LASTEXITCODE" }
$d = $json | ConvertFrom-Json
if ($d.app.version -ne $ExpectedVersion) { Fail "IEP version $($d.app.version), expected $ExpectedVersion" }
if ($d.protocol.name -ne "iep" -or $d.protocol.version -ne "0.1.0") { Fail "Invalid IEP descriptor" }
if (-not $dataExisted -and (Test-Path (Join-Path $dataDir "center.db"))) { Fail "--iep describe created a database" }
Write-Host "Installed app: --iep describe ok (IEP $($d.protocol.version), database: $($d.health.database))"

# --- Uninstall --------------------------------------------------------------------------------
$uninstaller = Join-Path $appDir "uninstall.exe"
if (-not (Test-Path $uninstaller)) { Fail "Uninstaller not found" }
# A marker proves that user data is kept.
New-Item -ItemType Directory -Force $dataDir | Out-Null
$marker = Join-Path $dataDir "installer-test.txt"
Set-Content -Path $marker -Value "keep me"
# The NSIS uninstaller copies itself to a temp folder and runs from there; watch the files.
Start-Process -FilePath $uninstaller -ArgumentList "/S" -Wait | Out-Null
Wait-Until { -not (Test-Path $regPath) } 60 "the uninstall registry entry to be removed"
Wait-Until { -not (Test-Path $exe) } 60 "the program file to be removed"
if (Test-Path $shortcut) { Fail "Start menu shortcut was not removed" }
if (-not (Test-Path $marker)) { Fail "Uninstalling deleted user data ($dataDir)" }
Remove-Item $marker
if (-not $dataExisted) { Remove-Item $dataDir -Recurse -Force -ErrorAction SilentlyContinue }
Write-Host "Uninstall: ok (program files and registry entry removed, user data kept)"
