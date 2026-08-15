// Full-flow test on a CLEAN Georgia sample: picks 2 random real sources (from
// the already-discovered Georgia URL set), runs the whole pipeline fresh
// (mine -> organize -> enrich -> render tabs 2/3/4), and reports. This is the
// "clean new Georgia sample, 2 random sources, make the map" test.
//
// Usage: node trip_app/test_full.js

const fs = require('fs');
const path = require('path');
const { runPipeline } = require('./pipeline/run');

const ROOT = path.join(__dirname, '..');
const DEST = 'גאורגיה-מלא';

// Real, already-discovered Georgia URLs (from the prior mining-URL discovery).
const URL_SOURCE = path.join(ROOT, 'גאורגיה', 'גאורגיה_Mining_URLs.json');

function pickRandom(arr, n) {
  const copy = arr.slice();
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

async function main() {
  if (!fs.existsSync(URL_SOURCE)) {
    console.error(`Missing ${URL_SOURCE} — need real Georgia URLs to run the test.`);
    process.exit(1);
  }
  const reuse = process.argv.includes('--reuse');
  const urlsByDomain = JSON.parse(fs.readFileSync(URL_SOURCE, 'utf-8'));
  const domains = Object.keys(urlsByDomain).filter((d) => (urlsByDomain[d] || []).length > 0);
  const dir = path.join(__dirname, 'trips', DEST);

  let chosen;
  if (reuse && fs.existsSync(path.join(dir, `${DEST}_sources.json`))) {
    // Reuse mode: keep the existing extraction, re-render only (test map/image fixes).
    chosen = JSON.parse(fs.readFileSync(path.join(dir, `${DEST}_sources.json`), 'utf-8')).map((s) => s.domain);
    console.log(`Reusing existing extraction; sources: ${chosen.join(', ')}\n`);
  } else {
    chosen = pickRandom(domains, 2);
    console.log(`Chosen 2 random sources: ${chosen.join(', ')}\n`);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); // fresh run
  }

  const trip = {
    destination: DEST,
    input: {
      destination: 'גאורגיה',
      dates: '1-10.9 (10 ימים)',
      days: 10,
      pace: 'רגוע',
      participants: '2',
      composition: '2 מבוגרים',
      transport: 'עם רכב שכור',
      emphases: 'טבע, הרים, אוכל מקומי, מקומות אותנטיים'
    },
    sources: chosen.map((domain) => ({
      name: domain,
      domain,
      coverage: 'מקור שנבחר אקראית לבדיקה',
      urls: urlsByDomain[domain].slice(0, 5)
    }))
  };

  const r = await runPipeline(trip, (m) => console.log(m), { reuseExtracted: reuse });
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(r, null, 2));
}

main().then(() => process.exit(0)).catch((err) => { console.error('FATAL:', err.message); process.exit(1); });
