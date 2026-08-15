// Tiny static file server for reviewing generated trips in a browser.
// Serves trip_app/trips/ on http://localhost:8080. Start it with view_trips.bat
// (or: node trip_app/serve.js) and open the printed URL.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { isPathSafe, serveStaticFile, renderTripIndexHtml } = require('./lib/staticServe');

const PORT = 8080;
const ROOT = path.join(__dirname, 'trips');

const server = http.createServer((req, res) => {
  // Strip any ?query so cache-busting params don't turn into a bogus filename.
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') {
    // Index: list the available trips as links.
    let trips = [];
    try { trips = fs.readdirSync(ROOT).filter((d) => fs.statSync(path.join(ROOT, d)).isDirectory()); } catch {}
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderTripIndexHtml(trips));
    return;
  }
  const filePath = path.join(ROOT, urlPath);
  // Prevent path traversal outside ROOT.
  if (!isPathSafe(filePath, ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  serveStaticFile(res, filePath);
});

server.listen(PORT, () => {
  console.log(`\n  KESSLER TRIP viewer running.`);
  console.log(`  Open in your browser:  http://localhost:${PORT}/\n`);
  console.log(`  (Leave this window open while reviewing. Close it to stop.)\n`);
});
