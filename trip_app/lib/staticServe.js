// Shared static-file serving used by both the live server (server.js) and
// the standalone read-only trip viewer (serve.js). These had already
// drifted: server.js's MIME table included .ico, serve.js's didn't, so a
// favicon silently 404'd only through the dev-viewer path.
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ico': 'image/x-icon'
};

function isPathSafe(filePath, root) {
  return filePath.startsWith(root);
}

function serveStaticFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('לא נמצא'); return; }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }); // no-store: never show a stale cached tab
    res.end(data);
  });
}

// extraFooterHtml lets server.js add its "+ new trip" link, which makes no
// sense on serve.js's read-only viewer.
function renderTripIndexHtml(trips, extraFooterHtml = '') {
  const links = trips.map((t) => `<li><a href="/${encodeURIComponent(t)}/${encodeURIComponent(t)}_KESSLER_TRIP.html">${t}</a></li>`).join('');
  return `<!doctype html><html dir="rtl"><meta charset="utf-8"><body style="font-family:Segoe UI,Arial;padding:40px"><h1>KESSLER TRIP — טיולים</h1><ul>${links || '<li>אין טיולים עדיין</li>'}</ul>${extraFooterHtml}</body></html>`;
}

module.exports = { MIME, isPathSafe, serveStaticFile, renderTripIndexHtml };
