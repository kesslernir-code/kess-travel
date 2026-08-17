// Publishes the static trip viewer: regenerates the trip-gallery index (one
// card per trip, with its hero photo + tagline) and deploys trip_app/trips/
// as a static site via the already-authenticated local `netlify` CLI -- no
// new login, no secrets handled here, nothing beyond what a human running
// `netlify deploy` themselves would do.

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { renderTripIndexHtml } = require('../lib/staticServe');

const TRIPS_DIR = path.join(__dirname, '..', 'trips');
const ROOT = path.join(__dirname, '..', '..');

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}

// One gallery card's worth of data per trip: the same hero image
// renderShowcase already picked (the first highlight that resolved a photo)
// and the tagline -- both already written by the enrich stage, no new work.
function collectTripCards() {
  let names = [];
  try { names = fs.readdirSync(TRIPS_DIR).filter((d) => fs.statSync(path.join(TRIPS_DIR, d)).isDirectory()); } catch { /* none yet */ }
  return names.map((name) => {
    const enrich = readJsonSafe(path.join(TRIPS_DIR, name, `${name}_enrich.json`));
    const image = enrich ? (((enrich.highlights || []).find((h) => h.image) || {}).image || enrich._fallbackImg || null) : null;
    return { name, image, tagline: (enrich && enrich.tagline) || '' };
  });
}

// netlify.cmd on Windows can only be spawned through a shell (Node's
// child_process can't exec .cmd/.bat files directly -- naming the .cmd
// explicitly without shell:true still fails with EINVAL, this is a known
// Windows limitation, not specific to this command). Using exec() with a
// plain command string (rather than execFile's argv-array + shell:true,
// which triggers a Node deprecation warning about unescaped args) -- safe
// here since every part of the command is a fixed literal, never
// user/trip-controlled data.
function runNetlifyDeploy(onProgress) {
  const log = onProgress || (() => {});
  return new Promise((resolve, reject) => {
    exec(
      'netlify deploy --dir=trip_app/trips --prod --message "Auto-publish after final plan"',
      // windowsHide: exec() on Windows runs the command through a fresh
      // cmd.exe, which pops up a visible console window by default even
      // though this whole app (including the server itself) is meant to run
      // with no visible windows at all -- a real report: the ONLY thing a
      // user saw after confirming was that flash, with no dashboard progress
      // indicator visible yet.
      { cwd: ROOT, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) { log(`netlify deploy failed: ${err.message}`); reject(err); return; }
        log('netlify deploy complete');
        resolve(stdout);
      }
    );
  });
}

async function publishTrips(onProgress) {
  const log = onProgress || (() => {});
  const cards = collectTripCards();
  fs.writeFileSync(path.join(TRIPS_DIR, 'index.html'), renderTripIndexHtml(cards), 'utf-8');
  log(`gallery index regenerated for ${cards.length} trip(s)`);
  await runNetlifyDeploy(log);
}

module.exports = { publishTrips, collectTripCards };

if (require.main === module) {
  publishTrips((m) => console.log(m))
    .then(() => process.exit(0))
    .catch((err) => { console.error('FATAL:', err.message); process.exit(1); });
}
