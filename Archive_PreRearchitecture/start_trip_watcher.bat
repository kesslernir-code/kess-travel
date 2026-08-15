@echo off
cd /d "%~dp0"
echo Starting KESSLER_TRIP headless auto-trigger watcher...
echo This watches for new trips submitted via the form, and new map selections,
echo and runs Claude Code headlessly to build the rest of the pipeline for you.
echo Close this window (or press Ctrl+C) to stop it.
echo.
node trip_watcher.js
pause
