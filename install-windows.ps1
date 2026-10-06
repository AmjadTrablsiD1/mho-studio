# Install MHO Studio on Windows 10 / 11: build the interface, copy the app to
# %LOCALAPPDATA%\Programs\mho-studio, and put "MHO Studio" shortcuts on the
# Desktop and in the Start menu. Safe to run again after every update.
#
# Run it by double-clicking install-windows.bat (next to this file).
# Needs Node.js 22.18 or newer: https://nodejs.org (or: winget install OpenJS.NodeJS.LTS)
#
# Written on a Mac and checked by reading, not yet run on Windows: if a step
# fails, the message says which one.

$ErrorActionPreference = "Stop"
$AppName = "MHO Studio"
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA "Programs\mho-studio"

function Step($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }

# 1. Node.js, 22.18 or newer (it runs the app's TypeScript directly).
Step "Checking Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Write-Host "Node.js is not installed (or not on PATH)." -ForegroundColor Red
  Write-Host "Install Node.js 22 LTS or newer from https://nodejs.org, or run:  winget install OpenJS.NodeJS.LTS"
  Write-Host "then open a new window and run install-windows.bat again."
  exit 1
}
$Node = $nodeCmd.Source
$ver = (& $Node -v).Trim().TrimStart("v").Split(".")
if ([int]$ver[0] -lt 22 -or ([int]$ver[0] -eq 22 -and [int]$ver[1] -lt 18)) {
  Write-Host "Node.js $(& $Node -v) is too old; MHO Studio needs 22.18 or newer (https://nodejs.org)." -ForegroundColor Red
  exit 1
}
$Npm = Join-Path (Split-Path -Parent $Node) "npm.cmd"
if (-not (Test-Path $Npm)) { $Npm = "npm.cmd" }
Write-Host "node: $Node ($(& $Node -v))"

# 2. Build the interface in the source folder.
Step "Building the interface"
Push-Location (Join-Path $Src "ui")
try {
  & $Npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install in ui failed" }
  & $Npm run build
  if ($LASTEXITCODE -ne 0) { throw "building the interface failed" }
} finally { Pop-Location }

# 3. A running copy would keep its old code: stop it.
Step "Stopping a running $AppName, if any"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*mho-studio*server*main.ts*" } |
  ForEach-Object { Write-Host "stopping process $($_.ProcessId)"; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

# 4. Copy the app. Settings and presets live in %USERPROFILE%\.config\mho-studio and are not touched.
Step "Copying to $Dest"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
robocopy $Src $Dest /MIR /NFL /NDL /NJH /NJS /NP /XD .git node_modules test-results playwright-report screenshots .github /XF .DS_Store | Out-Null
if ($LASTEXITCODE -ge 8) { throw "copying the files failed (robocopy exit $LASTEXITCODE)" }

# 5. The server's one optional dependency (USB-TMC). Without it, LAN and the simulators still work.
Step "Installing USB support (optional)"
Push-Location (Join-Path $Dest "server")
try {
  & $Npm install --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Write-Host "note: USB support could not be installed; LAN and the simulators still work." -ForegroundColor Yellow }
} finally { Pop-Location }

# 6. Shortcuts: node.exe running the server, which opens the browser. The console window
#    starts minimised; the app stops by itself about 20 s after its browser tab is closed.
Step "Creating shortcuts"
$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath("Desktop")) "$AppName.lnk"),
  (Join-Path ([Environment]::GetFolderPath("Programs")) "$AppName.lnk")
)
foreach ($lnk in $targets) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $Node
  $s.Arguments = '"' + (Join-Path $Dest "server\main.ts") + '"'
  $s.WorkingDirectory = $Dest
  $s.IconLocation = (Join-Path $Dest "branding\icon.ico") + ",0"
  $s.WindowStyle = 7
  $s.Description = "Remote bench for RIGOL MHO900 and Teledyne LeCroy oscilloscopes"
  $s.Save()
  Write-Host "  $lnk"
}

Write-Host ""
Write-Host "$AppName is installed. Start it from the Desktop or the Start menu." -ForegroundColor Green
Write-Host "If Windows Firewall asks about Node.js, allow it on Private networks (needed to reach the scope)."
