@echo off
REM Double-click to install MHO Studio on Windows 10 / 11 (runs install-windows.ps1).
REM Not yet run on a Windows machine: written and checked on a Mac.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
echo.
pause
