@echo off
REM UNTESTED: written on a Mac, never run on Windows. Needs Node 22.18+ on PATH.
REM The oscilloscope must be reachable on the LAN (raw SCPI, TCP port 5555).
cd /d "%~dp0"
if not exist ui\dist\index.html (
  pushd ui
  call npm install
  call npm run build
  popd
)
start "" node "%~dp0server\main.ts"
