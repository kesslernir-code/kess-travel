# KESSLER_TRIP desktop shortcut setup
# -----------------------------------------------------------------------
# One-time setup: creates a real shortcut on your Desktop that points at
# start_kessler_trip.vbs. Run this once yourself (double-click it, or
# right-click > Run with PowerShell) -- Claude Code's own sandbox can't
# reliably write to your real Desktop, so this step needs to happen from
# your own session.
#
# Safe to re-run: it just overwrites the same shortcut each time.

$tripPlannerDir = $PSScriptRoot
$target = Join-Path $tripPlannerDir "start_kessler_trip.vbs"
$desktop = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktop "KESSLER_TRIP.lnk"

if (-not (Test-Path $target)) {
    Write-Host "ERROR: $target not found. Run this script from inside the Trip Planner folder." -ForegroundColor Red
    exit 1
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = $tripPlannerDir
$shortcut.Description = "Open the KESSLER_TRIP new-trip form (auto-starts the background pipeline watcher)"
$iconPath = Join-Path $tripPlannerDir "kess_trip_icon.ico"
if (Test-Path $iconPath) {
    $shortcut.IconLocation = $iconPath
} else {
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
}
$shortcut.Save()

Write-Host "Created desktop shortcut: $shortcutPath" -ForegroundColor Green

# Windows caches icon bitmaps by file path, so overwriting kess_trip_icon.ico's
# content while keeping the same filename often doesn't visibly refresh the
# shortcut on the Desktop. Force a real refresh: touch the shortcut's own
# timestamp, clear the shell icon cache, then restart Explorer so it re-reads
# icons instead of serving stale cached bitmaps. Explorer restarting briefly
# flickers the desktop/taskbar -- nothing is lost, open app windows stay open.
(Get-Item $shortcutPath).LastWriteTime = Get-Date
Start-Process "$env:SystemRoot\System32\ie4uinit.exe" -ArgumentList "-ClearIconCache" -Wait -ErrorAction SilentlyContinue
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Start-Process explorer.exe

Write-Host "Refreshed the icon cache and restarted Explorer so the new icon actually shows up." -ForegroundColor Green
Write-Host "Double-click it any time to open the new-trip form -- the background watcher starts itself if it isn't already running."
