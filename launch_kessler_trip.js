// KESSLER_TRIP one-click launcher
// -----------------------------------------------------------------------
// What the desktop icon actually runs. Starts the live app server (hidden,
// if it isn't already running) and opens the New Trip form -- served BY that
// same server now, not as a standalone file:// page, so the form and its API
// calls are always same-origin. Safe to run repeatedly -- it never starts a
// second copy of the server.
//
// Replaces the old two-process design (local_server.js + trip_watcher.js
// polling files and running `claude -p` to orchestrate everything) with a
// single Node server (trip_app/server.js) that does mining/organizing/
// rendering itself, in-process, via the Gemini API -- see trip_app/ for why.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, exec } = require('child_process');

const ROOT = __dirname;
const LOGS_DIR = path.join(ROOT, 'logs');
// 8090 collided with an unrelated background service on this machine
// (Wondershare's WsToastNotification.exe also listens there) -- picked a
// distinctly uncommon port instead to avoid a repeat of that silent conflict.
const SERVER_PORT = 8234;
const SERVER_SCRIPT = path.join(ROOT, 'trip_app', 'server.js');

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// A real GET to /health, not just a TCP connect -- a bare port-open check
// can't tell this app apart from some unrelated process squatting the same
// port (exactly what happened once during testing), which would make the
// launcher wrongly skip starting the real server.
function isServerRunning() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: SERVER_PORT, path: '/health', timeout: 1200 }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data).app === 'kessler-trip-live'); } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function spawnHidden(scriptPath, logName) {
  const logFd = fs.openSync(path.join(LOGS_DIR, logName), 'a');
  const child = spawn(process.execPath, [scriptPath], {
    cwd: path.dirname(scriptPath),
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

function openForm() {
  exec(`start "" "http://localhost:${SERVER_PORT}/"`, (err) => {
    if (err) console.error('Failed to open the trip form:', err.message);
  });
}

async function main() {
  const serverUp = await isServerRunning();
  if (!serverUp) {
    const pid = spawnHidden(SERVER_SCRIPT, 'trip_app_server.log');
    console.log(`Started trip_app/server.js (pid ${pid})`);
  } else {
    console.log('trip_app/server.js already running');
  }
  // Give the server a moment to bind its port before the browser's first request.
  setTimeout(openForm, serverUp ? 0 : 900);
}

main();
