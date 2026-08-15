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

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// A photo-card gallery of every trip -- one flavor image (the same hero photo
// renderShowcase already picked: the first resolved highlight image) plus the
// trip's tagline, already written by the enrich stage, so there's no new work
// to produce these, just to display them. Clicking a card goes straight to
// that trip's full 7-tab dashboard. `trips` is [{name, image, tagline}].
// extraFooterHtml lets server.js add its "+ new trip" link, which makes no
// sense on serve.js's read-only viewer.
function renderTripIndexHtml(trips, extraFooterHtml = '') {
  const cards = trips.map((t) => {
    const bg = t.image ? `background-image:url('${esc(t.image)}')` : `background:linear-gradient(135deg,#4a3d2e,#2a2320)`;
    return `    <a class="trip-card" href="/${encodeURIComponent(t.name)}/${encodeURIComponent(t.name)}_KESSLER_TRIP.html">
      <div class="trip-card-img" style="${bg}"></div>
      <div class="trip-card-body">
        <h2>${esc(t.name)}</h2>
        ${t.tagline ? `<p>${esc(t.tagline)}</p>` : ''}
      </div>
    </a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KESSLER TRIP — הטיולים שלי</title>
<style>
  :root { --ink:#241f1a;--paper:#faf6ef;--muted:#6b6157;--gold:#c8a24a;--accent:#a13d3d; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:'Segoe UI',Arial,sans-serif; direction:rtl; text-align:right; padding:40px 6vw 60px; }
  h1 { font-size:32px; margin:0 0 6px; }
  .kicker { font-size:13px; letter-spacing:2px; color:var(--gold); font-weight:700; text-transform:uppercase; margin-bottom:20px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:22px; }
  .trip-card { display:block; background:#fff; border-radius:14px; overflow:hidden; text-decoration:none; color:inherit; box-shadow:0 3px 14px rgba(60,45,25,0.09); transition:transform .15s ease; }
  .trip-card:hover { transform:translateY(-3px); }
  .trip-card-img { height:170px; background-size:cover; background-position:center; }
  .trip-card-body { padding:16px 18px 20px; }
  .trip-card-body h2 { margin:0 0 6px; font-size:20px; }
  .trip-card-body p { margin:0; font-size:14px; color:var(--muted); }
  .empty { color:var(--muted); text-align:center; padding:80px 0; font-size:15px; }
</style>
</head>
<body>
  <div class="kicker">KESSLER TRIP</div>
  <h1>הטיולים שלי</h1>
  ${trips.length ? `<div class="grid">\n${cards}\n  </div>` : `<div class="empty">אין טיולים עדיין</div>`}
  ${extraFooterHtml}
</body>
</html>`;
}

module.exports = { MIME, isPathSafe, serveStaticFile, renderTripIndexHtml };
