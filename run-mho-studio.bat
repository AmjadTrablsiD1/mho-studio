@echo off
REM UNTESTED: written on a Mac, never run on Windows. Needs Node 22.18+ on PATH.
REM The oscilloscope must be reachable on the LAN (raw SCPI, TCP port 5555), or on USB:
REM for USB the scope's interface needs the WinUSB driver (Zadig) if NI-VISA/UltraSigma claimed it.
cd /d "%~dp0"
if not exist server\node_modules\usb (
  pushd server
  call npm install --omit=dev
  popd
)
if not exist ui\dist\index.html (
  pushd ui
  call npm install
  call npm run build
  popd
)
start "" node "%~dp0server\main.ts"
