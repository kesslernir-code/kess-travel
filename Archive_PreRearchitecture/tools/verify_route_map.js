// KESSLER_TRIP — Route_Map.html static verifier
// -----------------------------------------------------------------------
// Usage:  node tools/verify_route_map.js "<Destination>/<Destination>_Route_Map.html"
//
// Statically checks a generated selection map against the contract defined
// in Skills_Reference/trip-master-plan_SKILL.md (Part B). This is the QA
// gate trip-master-plan's Step 6b runs before wiring the map into the
// dashboard — a build that fails here has a real feature missing or a
// known-bad pattern present, not a style nit.
//
// Checks are regex-based on the file's source text (the page can't actually
// run outside a browser with a Maps key), so they verify presence/absence
// of required identifiers and known-bad patterns — they can't prove runtime
// behavior. That's still enough to catch every regression this pipeline has
// actually hit so far: renamed/missing features, polygon region overlays,
// multiple InfoWindows, label:null, dir="rtl" on <html>, top-level
// google.maps class extensions.
//
// Exit code: 0 = all required checks pass, 1 = at least one FAIL.

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/verify_route_map.js <path-to-Route_Map.html>');
  process.exit(1);
}
let html;
try {
  html = fs.readFileSync(file, 'utf-8');
} catch (e) {
  console.error(`FAIL cannot read ${file}: ${e.message}`);
  process.exit(1);
}

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ' — ' + detail : ''}`);
  }
}
function count(re) {
  const m = html.match(re);
  return m ? m.length : 0;
}

// --- Naming contract -----------------------------------------------------
check('const DESTINATION_NAME', /const\s+DESTINATION_NAME\s*=/.test(html));
check('const LOCAL_SERVER_URL (localhost:8787/confirm-selection)',
  /const\s+LOCAL_SERVER_URL\s*=\s*['"]http:\/\/localhost:8787\/confirm-selection['"]/.test(html));
check('const TRIP_DAYS (integer)', /const\s+TRIP_DAYS\s*=\s*\d+/.test(html));
check('const TRIP_PACE', /const\s+TRIP_PACE\s*=/.test(html));
check('const INTEREST_CATEGORIES', /const\s+INTEREST_CATEGORIES\s*=/.test(html));
check('const SLEEP_MARKER_SCALE', /const\s+SLEEP_MARKER_SCALE\s*=/.test(html));
check('SLEEP_MARKER_SCALE actually used beyond its declaration',
  count(/SLEEP_MARKER_SCALE/g) >= 2);

for (const fn of ['applyCategoryFilter', 'suggestSelection', 'focusMapPoint', 'highlightRegion', 'sendSelectionToLocalServer']) {
  check(`function ${fn}`, new RegExp(`function\\s+${fn}\\s*\\(`).test(html));
}

// --- Region highlight: circle, never polygon ------------------------------
check('region highlight uses google.maps.Circle', /new\s+google\.maps\.Circle\s*\(/.test(html));
check('no google.maps.Polygon region overlay (rejected pattern)',
  !/new\s+google\.maps\.Polygon\s*\(/.test(html),
  'convex-hull/polygon overlays render as wrong-looking connect-the-dots shapes');
check('highlightRegion fits bounds to the circle (padded), not the whole country', /fitBounds/.test(html));

// --- Info windows: exactly one shared instance -----------------------------
const infoWindows = count(/new\s+google\.maps\.InfoWindow\s*\(/g);
check('exactly one shared InfoWindow instance', infoWindows === 1,
  `found ${infoWindows}`);

// --- Known-fatal patterns ---------------------------------------------------
// Strip line comments first: skills document this trap in comments ("label:null throws"),
// and a comment mentioning the pattern must not fail the check for actually using it.
const htmlNoComments = html.replace(/^\s*\/\/.*$/gm, '');
check('no literal label: null passed to Marker', !/label\s*:\s*null/.test(htmlNoComments),
  'Marker constructor throws on explicit null label, silently killing that marker\'s setup');
check('no top-level `class X extends google.maps.*`',
  !/^class\s+\w+\s+extends\s+google\.maps\./m.test(html),
  'Maps script loads async; a top-level extends throws ReferenceError and kills the rest of the script block');
check('geocoding uses componentRestrictions country lock', /componentRestrictions/.test(html));

// --- RTL traps ---------------------------------------------------------------
check('<html> tag has NO dir="rtl" (map+sidebar flex-order trap)',
  !/<html[^>]*dir\s*=\s*["']rtl["']/i.test(html));
check('sidebar carries RTL styling instead', /#sidebar[^}]*direction\s*:\s*rtl/s.test(html) || /direction\s*:\s*rtl/.test(html));

// --- UI features -------------------------------------------------------------
check('category filter row with הצג הכל', /הצג הכל/.test(html));
check('suggest button (הצע בחירה)', /הצע בחירה/.test(html));
check('confirm-selection POST payload includes isSleep', /isSleep/.test(html));
check('Google Maps script tag with geometry library', /maps\.googleapis\.com\/maps\/api\/js\?[^"']*libraries=[^"']*geometry/.test(html));

// -----------------------------------------------------------------------------
console.log('');
if (failures === 0) {
  console.log(`ALL CHECKS PASSED (${file})`);
  process.exit(0);
} else {
  console.log(`${failures} CHECK(S) FAILED (${file}) — fix and re-run before updating the dashboard.`);
  process.exit(1);
}
