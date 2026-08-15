// KESSLER_TRIP local helper server
// -----------------------------------------------------------------------
// Runs entirely on this computer, no internet connection needed and no
// data ever leaves this machine. Its jobs are to (1) receive two kinds of
// submissions from local pages opened in the browser (New_Trip_Form.html
// and any destination's <Destination>_Route_Map.html) and write them
// straight to disk in this same folder -- replacing the need to describe
// a new trip or a map selection back in a Claude chat conversation -- and
// (2) watch this folder tree for a brand-new <Destination>_KESSLER_TRIP.html
// dashboard file and open it automatically in the default browser the
// moment it appears, so starting a plan doesn't require finding and
// double-clicking the file yourself.
//
// Start it by double-clicking start_local_server.bat, or running:
//   node local_server.js
// from this folder. Leave the window open while using the form or the map.
// Press Ctrl+C (or just close the window) to stop it.
//
// Endpoints:
//   POST /new-trip           { destination, when, participants, composition, car, emphases }
//                            -> writes <Destination>/<Destination>_Trip_Input.md
//   POST /confirm-selection  { destination, points: [{id,name,category,region}, ...] }
//                            -> writes <Destination>/<Destination>_Selection.json
//
// Both endpoints create the destination folder if it doesn't exist yet.
//
// Background (no endpoint, just a folder watcher): the first time a file
// named *_KESSLER_TRIP.html shows up anywhere under this folder during this
// server run, it's opened once via the Windows `start` command. Dashboards
// that already existed before the server started are never auto-opened
// (only genuinely new ones), and a dashboard already opened once is never
// re-opened just because a later pipeline stage updates one of its tabs.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8787;
const ROOT = __dirname; // this script must live directly inside the "Trip Planner" folder

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Strip characters that aren't safe in a Windows folder/file name, so a
// destination typed with odd punctuation can't produce a broken path.
function sanitizeFolderName(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '');
}

function tripInputMarkdown(d) {
  const now = new Date().toLocaleString('he-IL');
  return `# נתוני טיול — ${d.destination}

**לאיפה:** ${d.destination || ''}
**מתי:** ${d.when || ''}
**כמה ימים:** ${d.days || ''}
**כמה לילות:** ${d.nights || ''}
**כמה משתתפים:** ${d.participants || ''}
**כולל ילדים או מבוגרים:** ${d.composition || ''}
**עם רכב או בלי רכב:** ${d.car || ''}
**דגשים מיוחדים:** ${d.emphases || ''}

*נוצר אוטומטית דרך הטופס המקומי (New_Trip_Form.html), ${now}*
`;
}

// A brand-new trip's real dashboard only gets built minutes later by the
// headless pipeline -- until then, submitting the form looked like nothing
// happened at all. This placeholder opens immediately so there's instant
// feedback; the real dashboard still auto-opens separately, in its own tab,
// via the existing watcher below, once the pipeline actually builds it.
function loadingPageHtml(destination) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl"><head><meta charset="UTF-8">
<title>מתכננים את ${destination}...</title>
<style>
  body { font-family: 'Segoe UI', Arial, sans-serif; background:#faf6ef; color:#241f1a;
         display:flex; align-items:center; justify-content:center; height:100vh; margin:0; text-align:center; }
  .box { max-width: 480px; padding: 20px; }
  .clock { font-size: 64px; animation: tick 1.4s steps(1) infinite; }
  @keyframes tick { 0%{transform:rotate(0deg)} 50%{transform:rotate(15deg)} 100%{transform:rotate(0deg)} }
  h1 { font-size: 22px; margin: 16px 0 8px; }
  p { color:#6b6157; font-size: 14px; line-height: 1.6; }
</style></head>
<body>
  <div class="box">
    <div class="clock">🕐</div>
    <h1>מתכננים את הטיול ל${destination}...</h1>
    <p>הפייפליין רץ ברקע ועושה מחקר, בונה מפה ובונה את הדשבורד. זה יכול לקחת כמה דקות.<br>
    אפשר לסגור את הטאב הזה — הדשבורד האמיתי יפתח לבד בטאב חדש כשיהיה מוכן.</p>
  </div>
</body></html>`;
}

function ensureDestDir(destination) {
  const folderName = sanitizeFolderName(destination);
  const destDir = path.join(ROOT, folderName);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  return { folderName, destDir };
}

// ---- Auto-open new KESSLER_TRIP dashboards -----------------------------
const DASHBOARD_SUFFIX = '_KESSLER_TRIP.html';
const openedDashboards = new Set();

// Record every dashboard that already exists when the server starts, so
// the watcher below only reacts to files that are genuinely new from this
// point on -- restarting the server should never re-open old trips.
function seedExistingDashboards(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      seedExistingDashboards(full);
    } else if (entry.isFile() && entry.name.endsWith(DASHBOARD_SUFFIX)) {
      openedDashboards.add(full);
    }
  }
}

function openInBrowser(filePath) {
  // `start` is a cmd.exe builtin (not a real executable), so this needs a
  // shell -- exec() runs through cmd.exe on Windows, execFile() would not.
  // The leading "" is a required empty window-title argument; without it,
  // a quoted path is misread by `start` as the title instead of the path.
  exec(`start "" "${filePath}"`, (err) => {
    if (err) console.error('[auto-open] failed to open', filePath, err.message);
    else console.log(`[auto-open] opened ${filePath}`);
  });
}

function startDashboardWatcher() {
  seedExistingDashboards(ROOT);
  try {
    fs.watch(ROOT, { recursive: true }, (eventType, filename) => {
      if (!filename || !filename.endsWith(DASHBOARD_SUFFIX)) return;
      const full = path.join(ROOT, filename);
      if (openedDashboards.has(full)) return;
      if (!fs.existsSync(full)) return;
      // Mark it opened before the (async) exec call resolves, so a burst of
      // change events for the same brand-new file can't trigger it twice.
      openedDashboards.add(full);
      openInBrowser(full);
    });
    console.log('Watching for new trip dashboards to auto-open...');
  } catch (err) {
    console.error('Dashboard auto-open watcher failed to start (auto-open disabled):', err.message);
  }
}

const server = http.createServer(async (req, res) => {
  // Browsers send a CORS preflight OPTIONS request before a POST with a
  // JSON body when the page's origin is "null" (which is what a file://
  // page counts as) -- must answer it or the real POST never gets sent.
  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }

  try {
    if (req.method === 'POST' && req.url === '/new-trip') {
      const body = await readJsonBody(req);
      if (!body.destination) { sendJson(res, 400, { ok: false, error: 'destination is required' }); return; }
      const { folderName, destDir } = ensureDestDir(body.destination);
      const filePath = path.join(destDir, `${folderName}_Trip_Input.md`);
      fs.writeFileSync(filePath, tripInputMarkdown(body), 'utf-8');
      console.log(`[new-trip] wrote ${filePath}`);

      // Only pop the loading placeholder for a genuinely new trip -- if the
      // real dashboard already exists (e.g. someone resubmits the form to
      // patch a typo in an already-planned trip), don't reopen anything.
      const dashboardPath = path.join(destDir, `${folderName}_KESSLER_TRIP.html`);
      if (!fs.existsSync(dashboardPath)) {
        // A fresh submission always deserves a fresh auto-open later, even if
        // this exact dashboard path was already opened once before (e.g. an
        // earlier aborted pipeline attempt for this same destination built a
        // dashboard, and the server has been restarted since) -- the "already
        // opened" memory below is keyed by path, not content, so without this
        // it would wrongly stay silent forever once a path is marked opened.
        openedDashboards.delete(dashboardPath);
        const loadingPath = path.join(destDir, `${folderName}_KESSLER_TRIP_LOADING.html`);
        fs.writeFileSync(loadingPath, loadingPageHtml(body.destination), 'utf-8');
        openInBrowser(loadingPath);
      }

      sendJson(res, 200, { ok: true, path: filePath });
      return;
    }

    if (req.method === 'POST' && req.url === '/confirm-sources') {
      const body = await readJsonBody(req);
      if (!body.destination || !Array.isArray(body.domains)) {
        sendJson(res, 400, { ok: false, error: 'destination and domains[] are required' });
        return;
      }
      const { folderName, destDir } = ensureDestDir(body.destination);
      const filePath = path.join(destDir, `${folderName}_Sources_Selected.json`);
      const payload = {
        destination: body.destination,
        confirmedAt: new Date().toISOString(),
        domains: body.domains
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      console.log(`[confirm-sources] wrote ${filePath} (${body.domains.length} sources)`);
      sendJson(res, 200, { ok: true, path: filePath, count: body.domains.length });
      return;
    }

    if (req.method === 'POST' && req.url === '/confirm-selection') {
      const body = await readJsonBody(req);
      if (!body.destination || !Array.isArray(body.points)) {
        sendJson(res, 400, { ok: false, error: 'destination and points[] are required' });
        return;
      }
      const { folderName, destDir } = ensureDestDir(body.destination);
      const filePath = path.join(destDir, `${folderName}_Selection.json`);
      const payload = {
        destination: body.destination,
        confirmedAt: new Date().toISOString(),
        points: body.points
      };
      fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
      console.log(`[confirm-selection] wrote ${filePath} (${body.points.length} points)`);
      sendJson(res, 200, { ok: true, path: filePath, count: body.points.length });
      return;
    }

    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { ok: false, error: String(err && err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`KESSLER_TRIP local server running: http://localhost:${PORT}`);
  console.log('Keep this window open while using New_Trip_Form.html or confirming a map selection.');
  console.log('Press Ctrl+C to stop.');
  startDashboardWatcher();
});
