@echo off
cd /d "%~dp0"
echo Starting KESSLER TRIP viewer...
echo Open http://localhost:8080/ in your browser once it says it is running.
echo Close this window to stop.
echo.
node serve.js
pause
