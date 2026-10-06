@echo off
REM Start MHO Studio straight from this folder, without installing (install-windows.bat
REM installs it with Desktop and Start-menu shortcuts instead).
REM Not yet run on a Windows machine: written and checked on a Mac. Needs Node.js 22.18+ on PATH.
REM A RIGOL is reached on TCP 5555 or USB (WinUSB driver via Zadig if NI-VISA claimed it);
REM a Teledyne LeCroy on TCP 1861 (VICP).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get Node.js 22 LTS from https://nodejs.org or run: winget install OpenJS.NodeJS.LTS
  pause
  exit /b 1
)
if not exist server\node_modules\usb (
  pushd server
  call npm install --omit=dev --no-audit --no-fund
  popd
)
if not exist ui\dist\index.html (
  pushd ui
  call npm install --no-audit --no-fund
  call npm run build
  popd
)
start "MHO Studio" /min node "%~dp0server\main.ts"
