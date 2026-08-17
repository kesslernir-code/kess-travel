// KESSLER_TRIP live server. Replaces local_server.js + trip_watcher.js's
// file-polling with real HTTP endpoints the form/dashboard/map talk to
// directly. Every long stage (discovery, mining, final plan) runs in this
// same Node process -- no `claude -p` in the steady-state pipeline except
// discover.js's one bounded, WebSearch-only call. A request that kicks off a
// long stage responds immediately (202-style ack) and the stage keeps running
// in the background; the dashboard tab fills in with the real file once the
// stage finishes, same "pending -> ready" pattern the dashboard already uses.

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  runDiscoveryStage, runMiningStage, runFinalPlanStage, runExpandSourcesStage,
  ensureTripDir, tripDir
} = require('./pipeline/run');
const { renderDashboard } = require('./pipeline/render');
const { serveStaticFile, renderTripIndexHtml, isPathSafe } = require('./lib/staticServe');
const { publishTrips, collectTripCards } = require('./pipeline/publish');

// 8090 turned out to collide with an unrelated background service already
// running on this machine (Wondershare's WsToastNotification.exe) -- after
// this server was killed once during testing, that process silently grabbed
// the now-free port and the next request got its (unrelated) response
// instead of an obvious "connection refused". Picked a distinctly uncommon
// port instead of debugging that class of confusion again.
const PORT = 8234;
const ROOT = path.join(__dirname, '..');
const TRIPS_DIR = path.join(__dirname, 'trips');
const FORM_PATH = path.join(ROOT, 'New_Trip_Form.html');
const LOG_PATH = path.join(__dirname, '..', 'logs', 'trip_app_server.log');

function log(msg) {
  const line = `[${new Date().toLocaleString('he-IL')}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n', 'utf-8'); } catch { /* best-effort */ }
}

// Strip characters unsafe in a Windows folder name -- same rule local_server.js
// used, so a destination typed with odd punctuation can't produce a broken path.
function sanitizeFolderName(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '');
}

function sendJson(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (err) { reject(err); } });
    req.on('error', reject);
  });
}

// Trip-form payload -> the `input` object every pipeline stage expects.
function formToInput(body) {
  const days = parseInt(body.days, 10) || (parseInt(body.nights, 10) ? parseInt(body.nights, 10) + 1 : 5);
  const dates = body.when || (body.days ? `${body.days} ימים` : '');
  return {
    destination: (body.destination || '').trim(),
    dates,
    days,
    pace: body.pace || 'רגוע',
    participants: body.participants || '',
    composition: body.composition || '',
    transport: body.car || '',
    emphases: body.emphases || ''
  };
}

// Identity header on every response, and a dedicated health-check route --
// so anything checking "is my server up" (the launcher, a human with curl)
// can tell THIS app answered, not some unrelated process that happens to be
// squatting the same port (a real thing that happened once during testing:
// Wondershare's WsToastNotification.exe also uses a port this app tried).
const APP_ID = 'kessler-trip-live';
const server = http.createServer(async (req, res) => {
  res.setHeader('X-App', APP_ID);
  const urlPath = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return; }
  if (req.method === 'GET' && urlPath === '/health') { sendJson(res, 200, { ok: true, app: APP_ID }); return; }

  // ---- Form + trip index ---------------------------------------------
  if (req.method === 'GET' && (urlPath === '/' || urlPath === '/new-trip-form')) {
    serveStaticFile(res, FORM_PATH);
    return;
  }
  if (req.method === 'GET' && urlPath === '/trips') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderTripIndexHtml(collectTripCards(), '<p><a href="/new-trip-form">+ טיול חדש</a></p>'));
    return;
  }

  // ---- Stage 1: new trip -> discovery ---------------------------------
  if (req.method === 'POST' && urlPath === '/new-trip') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }
    const input = formToInput(body);
    if (!input.destination) { sendJson(res, 400, { ok: false, error: 'destination is required' }); return; }
    const folderName = sanitizeFolderName(input.destination);
    ensureTripDir(folderName);
    const dashboardUrl = `/${encodeURIComponent(folderName)}/${encodeURIComponent(folderName)}_KESSLER_TRIP.html`;

    // Idempotency guard: discovery is a real ~$0.35 claude -p call. The
    // client already disables its submit button, but that doesn't cover a
    // network-level retry or a resubmission for a destination already
    // discovered -- only a server-side check does. Reusing by default (not
    // asking) matches the standing "never re-run without being asked" rule;
    // an intentional fresh discovery means deleting the trip folder first.
    const discoveredPath = path.join(tripDir(folderName), `${folderName}_discovered_sources.json`);
    if (fs.existsSync(discoveredPath)) {
      log(`[${folderName}] discovery already exists -- reusing instead of re-running`);
      sendJson(res, 200, { ok: true, destination: folderName, dashboardUrl, reused: true });
      return;
    }

    try {
      // Discovery is a single bounded call (a minute or two) -- worth
      // awaiting so the form can redirect straight to a dashboard that
      // already has real sources on Tab 2, instead of a blank placeholder.
      await runDiscoveryStage(folderName, input, PORT, log);
      sendJson(res, 200, { ok: true, destination: folderName, dashboardUrl });
    } catch (err) {
      log(`[${folderName}] discovery נכשל: ${err.message}`);
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return;
  }

  // ---- Stage 2: confirmed sources -> mining/organize/enrich/render ----
  if (req.method === 'POST' && urlPath === '/confirm-sources') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }
    const folderName = sanitizeFolderName(body.destination);
    if (!folderName || !Array.isArray(body.domains) || !body.domains.length) {
      sendJson(res, 400, { ok: false, error: 'destination and domains[] are required' });
      return;
    }
    const dir = tripDir(folderName);
    const inputPath = path.join(dir, `${folderName}_input.json`);
    let input;
    try { input = JSON.parse(fs.readFileSync(inputPath, 'utf-8')); } catch { sendJson(res, 404, { ok: false, error: 'trip input not found -- run discovery first' }); return; }

    // Reuse a prior complete extraction if one's already on disk -- a retry
    // of this same request (dropped response, server restart mid-mine)
    // would otherwise silently re-pay for the whole scrape+Gemini-extract
    // pass instead of picking up where a complete run already got to.
    let reuseExtracted = false;
    try {
      const prevExtracted = JSON.parse(fs.readFileSync(path.join(dir, `${folderName}_Extracted_Points.json`), 'utf-8'));
      reuseExtracted = !!prevExtracted && prevExtracted.inProgress === false;
    } catch { /* no prior extraction on disk */ }

    // Respond immediately; mining/organize/enrich/render run in the background
    // and the dashboard's Tab 3/4 fill in when done -- a step this long must
    // never hold the HTTP connection open.
    sendJson(res, 200, { ok: true, message: 'mining started' });
    runMiningStage(folderName, input, body.domains, PORT, log, { reuseExtracted })
      .catch((err) => {
        log(`[${folderName}] שלב הכרייה נכשל: ${err.message}`);
        try { fs.writeFileSync(path.join(dir, `${folderName}_KESSLER_TRIP.html`), renderDashboard(folderName, input, { 2: true, 3: 'error', 4: 'error' }), 'utf-8'); } catch { /* best-effort */ }
      });
    return;
  }

  // ---- Top-up: search for more sources in specific categories ---------
  if (req.method === 'POST' && urlPath === '/expand-sources') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }
    const folderName = sanitizeFolderName(body.destination);
    if (!folderName || !Array.isArray(body.categories) || !body.categories.length) {
      sendJson(res, 400, { ok: false, error: 'destination and categories[] are required' });
      return;
    }
    // Real ~$0.35 claude -p call, same as initial discovery -- ack immediately,
    // run in the background, the Sources page polls itself for the new count.
    sendJson(res, 200, { ok: true, message: 'expand started' });
    runExpandSourcesStage(folderName, body.categories, PORT, log)
      .catch((err) => log(`[${folderName}] חיפוש מקורות נוספים נכשל: ${err.message}`));
    return;
  }

  // ---- Stage 3: confirmed map points -> final itinerary ---------------
  if (req.method === 'POST' && urlPath === '/confirm-selection') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: 'invalid JSON body' }); return; }
    const folderName = sanitizeFolderName(body.destination);
    if (!folderName || !Array.isArray(body.points) || !body.points.length) {
      sendJson(res, 400, { ok: false, error: 'destination and points[] are required' });
      return;
    }
    const dir = tripDir(folderName);
    const inputPath = path.join(dir, `${folderName}_input.json`);
    let input;
    try { input = JSON.parse(fs.readFileSync(inputPath, 'utf-8')); } catch { sendJson(res, 404, { ok: false, error: 'trip input not found' }); return; }

    // Images: always reuse whatever's already resolved by name -- redoing
    // the 25-30 min sequential image pass for places that already have a
    // photo would be pure waste regardless of why this request fired.
    const reuseImages = fs.existsSync(path.join(dir, `${folderName}_selection.json`));

    // Itinerary: only reuse if the confirmed selection is IDENTICAL to what
    // was confirmed last time (same points, same isSleep designations) --
    // that's a genuine retry (dropped response, resubmission) and re-paying
    // for the same Gemini call would be pure waste. But a user intentionally
    // returning to Tab 4 to add a point or lock in a real sleep location
    // needs a real rebuild, not a stale itinerary that ignores the change --
    // blindly reusing "because the file exists" would silently ignore
    // exactly the update they came back to make.
    let reuseItinerary = false;
    try {
      const itineraryPath = path.join(dir, `${folderName}_itinerary.json`);
      const prevSelection = JSON.parse(fs.readFileSync(path.join(dir, `${folderName}_selection.json`), 'utf-8'));
      const selectionKey = (pts) => pts.map((p) => `${p.name}|${!!p.isSleep}`).sort().join(',');
      reuseItinerary = fs.existsSync(itineraryPath) && selectionKey(prevSelection.selected || []) === selectionKey(body.points);
    } catch { /* no prior selection -- nothing to compare, definitely rebuild */ }

    sendJson(res, 200, { ok: true, message: 'final plan started' });
    runFinalPlanStage(folderName, input, body.points, log, { regionDays: body.regionDays || {}, reuseItinerary, reuseImages, serverPort: PORT })
      .then(() => {
        // Auto-publish: once a plan is actually finished, push the updated
        // static viewer live so the phone/other-device copy reflects it
        // without a manual `netlify deploy`. Failure here is caught locally
        // (not rethrown) -- a failed deploy (network blip, CLI not logged
        // in) must not get mistaken for the final-plan stage itself having
        // failed and mark tabs 5-7 as errored when the plan is actually fine.
        log(`[${folderName}] מפרסם עדכון לאתר הציבורי...`);
        return publishTrips(log).then(
          () => log(`[${folderName}] הפרסום הושלם`),
          (err) => log(`[${folderName}] הפרסום נכשל (התוכנית המקומית תקינה): ${err.message}`)
        );
      })
      .catch((err) => {
        log(`[${folderName}] שלב המסלול הסופי נכשל: ${err.message}`);
        try { fs.writeFileSync(path.join(dir, `${folderName}_KESSLER_TRIP.html`), renderDashboard(folderName, input, { 2: true, 3: true, 4: true, 5: 'error', 6: 'error', 7: 'error' }), 'utf-8'); } catch { /* best-effort */ }
      });
    return;
  }

  // ---- Static trip files (dashboard + every tab it embeds) ------------
  if (req.method === 'GET') {
    const filePath = path.join(TRIPS_DIR, urlPath);
    if (!isPathSafe(filePath, TRIPS_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    serveStaticFile(res, filePath);
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => {
  log(`KESSLER TRIP live server running on http://localhost:${PORT}/`);
  console.log(`\n  Open http://localhost:${PORT}/ to start a new trip.\n`);
});
