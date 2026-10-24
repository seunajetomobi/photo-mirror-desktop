@echo off
rem Photo Mirror for Windows without installing anything but Node.js.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Photo Mirror needs Node.js 18 or newer. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
set PM_OPEN=1
echo Starting Photo Mirror. If Windows asks about the firewall, allow "Private networks" so your phone can connect.
node server\server.js
pause
