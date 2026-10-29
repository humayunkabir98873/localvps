@echo off
rem LocalVPS launcher: starts the control panel and opens it in the browser.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22+ is required: https://nodejs.org/ & pause & exit /b 1)
if not exist node_modules\mysql2 (
  echo Installing panel dependencies...
  call npm install --omit=dev || (pause & exit /b 1)
)
node panel\server.js --open
