@echo off
cd /d "%~dp0"
echo Starting KESSLER_TRIP local server...
echo Keep this window open while you use New_Trip_Form.html or confirm a map selection.
echo Close this window (or press Ctrl+C) to stop it.
echo.
node local_server.js
pause
