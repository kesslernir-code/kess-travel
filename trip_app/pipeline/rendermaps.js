// Renders the Google-Maps artifacts (Route_Map = Tab 4, Final_Map = Tab 5) by
// injecting data into the REAL original templates (trip_app/templates/*.html),
// replacing only the data blocks and destination-specific config. Everything
// else -- the map JS, geocoding, routing, suggest-selection, styling -- is the
// original file verbatim, so behaviour and look are identical by construction.

const fs = require('fs');
const path = require('path');
const { pointsPerDayFromPace } = require('./suggest');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

// Gemini's 6 extraction categories -> the map's legend categories.
const CAT_MAP = { Urban: 'City', Attraction: 'Attraction', Nature: 'Nature', Food: 'Food', Sleep: 'Sleep', Other: 'Attraction' };

// Shared with render.js's renderChecklist -- a real bug happened from NOT
// sharing this: the checklist independently decided "needs a rental car"
// from baseNights.size > 1 (multiple overnight towns) instead of from what
// the user actually said in the trip form, so a single-base trip doing real
// car day-trips (e.g. Corfu: one base in the north, day trips around the
// island by car) showed "עם רכב" on Tab 1 but never listed a rental car on
// the checklist.
function hasCarTransport(transport) {
  const t = String(transport || '');
  return /רכב|car/i.test(t) && !/בלי\s*רכב|ללא\s*רכב|אין\s*רכב|no\s*car/i.test(t);
}

function slug(s, i) {
  const base = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
  return base ? `${base}${i}` : `p${i}`;
}

// The map template already has a full "Beach" category (color, legend,
// filter chip, sort order) -- but nothing ever assigned it, since Gemini's
// extraction schema has no distinct Beach value. A Nature/Other point whose
// own name says it's a beach gets reclassified here so that existing client
// feature actually works, instead of every beach silently landing under the
// generic Nature/Attraction bucket.
function inferCategory(p) {
  const mapped = CAT_MAP[p.category] || 'Attraction';
  if ((p.category === 'Nature' || p.category === 'Other') && /חוף|beach/i.test(p.name || '')) return 'Beach';
  return mapped;
}

// plan (organized) -> the REGIONS array the map template expects.
// prevByName (optional): Map<placeName, {checked, isSleep}> from a PRIOR
// confirmed selection -- lets a returning visit to this tab (after a trip
// already has a final plan) show what was actually chosen last time instead
// of resetting to "everything checked, nothing marked as a sleep base".
// customPoints (optional): prevSelection entries with custom=true -- a
// region's manually-typed "final accommodation" point (see the map's
// per-region sleep-location field) never came from the mined plan, so it has
// no place to be re-derived from except the saved selection itself; without
// this it would silently vanish the next time this tab is regenerated.
function toRegions(plan, destinationEn, prevByName, customPoints, prevRegionDays) {
  let idx = 0;
  return plan.regions.map((r) => {
    const points = r.places.map((p) => {
      idx++;
      const domain = (p.sources && p.sources[0]) || '';
      const prev = prevByName && prevByName.get(p.name);
      return {
        id: slug(p.name, idx),
        name: p.name,
        query: `${p.name}, ${destinationEn}`,
        category: inferCategory(p),
        rec: !!p.recommended,
        desc: p.description || '',
        source: (p.sources || []).join(' / '),
        url: domain ? (domain.startsWith('http') ? domain : `https://${domain}`) : '',
        checked: prevByName ? !!prev : true,
        isSleep: !!(prev && prev.isSleep)
      };
    });
    (customPoints || []).filter((cp) => cp.region === r.name).forEach((cp) => {
      idx++;
      points.push({
        id: slug(cp.name, idx),
        name: cp.name,
        query: `${cp.name}, ${destinationEn}`,
        category: 'Sleep',
        rec: false,
        desc: '',
        source: '',
        url: '',
        checked: true,
        isSleep: true,
        custom: true
      });
    });
    const region = { region: r.name, points };
    if (prevRegionDays && Object.prototype.hasOwnProperty.call(prevRegionDays, r.name)) {
      region.days = prevRegionDays[r.name];
    }
    return region;
  });
}

function readTemplate(name) {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
}

// ---- Route_Map (Tab 4): all points, user picks ----------------------------
// prevSelection (optional): the trip's saved selection.json's `selected`
// array, from a trip that already has a final plan -- returning to this tab
// then shows what's actually confirmed (and which points are official sleep
// bases) instead of resetting to a blank "everything checked" slate.
function renderRouteMap(plan, enrich, input, serverPort, prevSelection, prevRegionDays) {
  const destination = input.destination;
  const destinationEn = enrich.destinationEn || destination;
  const center = enrich.mapCenter || { lat: 0, lng: 0 };
  const countryCode = (enrich.countryCode || '').toUpperCase() || 'US';
  const days = Number(input.days) || 3;
  const pace = input.pace || 'רגוע';
  const prevByName = prevSelection && prevSelection.length
    ? new Map(prevSelection.map((p) => [p.name, { isSleep: !!p.isSleep }]))
    : null;
  const customPoints = (prevSelection || []).filter((p) => p.custom);
  const regions = toRegions(plan, destinationEn, prevByName, customPoints, prevRegionDays);

  // Main-city reference: distances to each region are measured FROM here, and
  // the first region (organize puts the base city first) is treated as "the
  // main city" (shown without a drive time).
  const mainCityName = enrich.mainCityName || destination;
  const mainCityEn = enrich.mainCityEn || destinationEn;
  const mainCityQuery = `${mainCityEn}, ${destinationEn}`;
  const mainCityRegion = (plan.regions[0] && plan.regions[0].name) || '';
  const mainCityCenter = enrich.mainCityCenter || enrich.mapCenter || center;
  const ONE_HOUR_DRIVE_M = 65000; // ~1 hour of driving as a radius

  // Config consts injected right after DESTINATION_NAME so the hardcoded-Milan
  // internals below can reference them instead of literal 'Duomo'/'IT'.
  const configConsts = `const DESTINATION_NAME = ${JSON.stringify(destination)};\n`
    + `const GEOCODE_COUNTRY = ${JSON.stringify(countryCode)};\n`
    + `const MAIN_CITY_QUERY = ${JSON.stringify(mainCityQuery)};\n`
    + `const MAIN_CITY_NAME = ${JSON.stringify(mainCityName)};\n`
    + `const MAIN_CITY_REGION = ${JSON.stringify(mainCityRegion)};\n`
    + `const MAIN_CITY_LATLNG = ${JSON.stringify(mainCityCenter)};\n`
    + `const ONE_HOUR_DRIVE_M = ${ONE_HOUR_DRIVE_M};`;

  let html = readTemplate('route_map.template.html');
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>Route Planner — ${destinationEn}</title>`)
    .replace(/<h2>מסלול מילאנו — כל נקודות העניין<\/h2>/, `<h2>מסלול ${destination} — כל נקודות העניין</h2>`)
    .replace(/const DESTINATION_NAME = '[^']*';/, configConsts)
    // Confirm button posts to this app's server, not the old local_server.js
    // on 8787 -- so clicking confirm actually reaches the live pipeline.
    .replace(/const LOCAL_SERVER_URL = 'http:\/\/localhost:8787\/confirm-selection';/, `const LOCAL_SERVER_URL = 'http://localhost:${serverPort}/confirm-selection';`)
    .replace(/const TRIP_DAYS = \d+;/, `const TRIP_DAYS = ${days};`)
    .replace(/const TRIP_PACE = '[^']*';/, `const TRIP_PACE = ${JSON.stringify(pace)};`)
    // Inject the SAME function pipeline/suggest.js uses server-side, instead
    // of the template keeping its own hand-typed copy -- these had already
    // drifted into different point-per-day numbers for the same pace, so the
    // server's test-harness "suggest" mirror and the real browser button
    // silently disagreed. One source of truth, byte-identical by construction.
    .replace(/function pointsPerDayFromPace\(pace\) \{[\s\S]*?\n\}/, pointsPerDayFromPace.toString())
    .replace(/const REGIONS = \[[\s\S]*?\n\];/, `const REGIONS = ${JSON.stringify(regions, null, 2)};`)
    .replace(/center: \{ lat: [\d.\-]+, lng: [\d.\-]+ \}/, `center: { lat: ${center.lat}, lng: ${center.lng} }`)
    .replace(/(maps\.googleapis\.com\/maps\/api\/js\?[^"]*?)&region=[A-Z]{2}/, `$1&region=${countryCode}`)
    // Geocoding was locked to Italy -- every point in any other country silently
    // failed to resolve, so no markers AND no region circles ever appeared.
    .replace(/componentRestrictions: \{ country: '[A-Z]{2}' \}/g, 'componentRestrictions: { country: GEOCODE_COUNTRY }')
    // Region-distance origin + labels: were hardcoded to the Milan Duomo.
    .replace(/origin: 'Duomo di Milano, Milan, Italy',/, 'origin: MAIN_CITY_QUERY,')
    .replace(/if \(r\.region === 'מרכז היסטורי ורובע האופנה'\) \{/, 'if (r.region === MAIN_CITY_REGION) {')
    .replace(/distEl\.textContent = 'אזור המרכז \(הדואומו\)';/, "distEl.textContent = 'אזור העיר הראשית (' + MAIN_CITY_NAME + ')';")
    .replace(/distEl\.textContent = 'מחשב מרחק מהדואומו\.\.\.';/, "distEl.textContent = 'מחשב מרחק מ' + MAIN_CITY_NAME + '...';")
    .replace(/distEl\.textContent = `כ-\$\{formatHebrewDuration\(leg\.duration\.value\)\} נסיעה מהדואומו`;/, "distEl.textContent = `כ-${formatHebrewDuration(leg.duration.value)} נסיעה מ${MAIN_CITY_NAME}`;")
    // Region highlight: the overlay was drawn but the map never moved to it, so
    // on a country-scale trip the circle/polygon lands off-screen. Fit to it.
    .replace(
      /\/\/ Deliberately not calling map\.fitBounds\(\)\/setZoom\(\) here[\s\S]*?that region\.\n\}/,
      `// Fit the map to the highlighted region so the circle/polygon is actually\n`
      + `  // visible -- on a country-scale trip regions are far apart, so a static\n`
      + `  // city-overview would leave the overlay off-screen.\n`
      + `  const overlayBounds = (regionOverlay.getBounds && regionOverlay.getBounds()) || bounds;\n`
      + `  map.fitBounds(overlayBounds);\n}`
    )
    // Persistent "base area" circle: ~1 hour of driving around the main city, so
    // it's clear at a glance what's a day-out-of-base vs a relocation. Drawn once
    // on map init, kept lightly styled so it doesn't fight the region overlays.
    .replace(
      /(sharedInfoWindow = new google\.maps\.InfoWindow\(\);\n)/,
      `$1  mainAreaCircle = new google.maps.Circle({\n`
      + `    center: MAIN_CITY_LATLNG, radius: ONE_HOUR_DRIVE_M,\n`
      + `    strokeColor: '#c8a24a', strokeOpacity: 0.9, strokeWeight: 2,\n`
      + `    fillColor: '#c8a24a', fillOpacity: 0.06, map: map, clickable: false, zIndex: 1\n`
      + `  });\n`
    )
    // Pass the region name so the main-city region can be shown as the 1-hour
    // circle instead of a convex hull that (for a country-scale trip) sprawls
    // across the whole map connecting far-apart points.
    .replace(/focusRegion\(r\.points\)/, 'focusRegion(r.points, r.region)')
    .replace(
      /function focusRegion\(regionPoints\) \{\n  const locs =/,
      `function focusRegion(regionPoints, regionName) {\n`
      + `  if (regionName === MAIN_CITY_REGION) {\n`
      + `    if (regionOverlay) { regionOverlay.setMap(null); regionOverlay = null; }\n`
      + `    const _mainRadius = regionRadiusCap();\n`
      + `    regionOverlay = new google.maps.Circle({\n`
      + `      center: MAIN_CITY_LATLNG, radius: _mainRadius,\n`
      + `      strokeColor: '#1a5fb4', strokeOpacity: 0.85, strokeWeight: 2,\n`
      + `      fillColor: '#1a5fb4', fillOpacity: 0.12, map: map\n`
      + `    });\n`
      + `    map.fitBounds(regionOverlay.getBounds());\n`
      + `    document.getElementById('status').textContent = 'האזור המרכזי — עיגול של כ-' + Math.round(_mainRadius/1000) + ' ק\\"מ סביב ' + MAIN_CITY_NAME + '.';\n`
      + `    return;\n`
      + `  }\n`
      + `  const locs =`
    )
    // Region highlight is ALWAYS a circle around the region's points -- never a
    // convex-hull polygon (which drew lines connecting far-apart places).
    // Uses the SAME computeRegionCircle() helper showAllRegions() calls
    // (defined once, un-touched, in the template) instead of re-deriving the
    // radius formula here -- one formula, one place to tune it.
    .replace(
      /  if \(locs\.length >= 3\) \{[\s\S]*?\n  \} else \{[\s\S]*?\n  \}/,
      `  const { center: _rc, radius: _rr } = computeRegionCircle(locs);\n`
      + `  regionOverlay = new google.maps.Circle({ center: _rc, radius: _rr, strokeColor: '#1a5fb4', strokeOpacity: 0.85, strokeWeight: 2, fillColor: '#1a5fb4', fillOpacity: 0.12, map: map });`
    );
  validateNoTemplateLeftovers(html, destinationEn);
  return html;
}

// QC guard: the map is built by injecting into the original Milan template, so
// the ONE way it can break is a template-specific value (a geocode query, the
// distance origin, the country restriction) surviving the injection -- which
// would send markers to the wrong country. This is exactly the bug that shipped
// once (country:'IT' geocoded every Georgia point into Italy). These asserts
// make that class of failure a hard error at render time, not a silent one the
// user has to catch by eye.
function validateNoTemplateLeftovers(html, destinationEn) {
  const problems = [];
  if (/country:\s*'IT'/.test(html)) problems.push("geocode restriction still hardcoded to 'IT'");
  if (/"query":\s*"[^"]*,\s*Italy"/.test(html)) problems.push('a geocode query still ends in ", Italy"');
  if (/origin:\s*'Duomo di Milano/.test(html)) problems.push("distance origin still hardcoded to the Milan Duomo");
  if (!html.includes('componentRestrictions: { country: GEOCODE_COUNTRY }')) problems.push('geocode restriction was not rewired to GEOCODE_COUNTRY');
  if (!html.includes('origin: MAIN_CITY_QUERY')) problems.push('distance origin was not rewired to MAIN_CITY_QUERY');
  // Every geocode query should target this destination, not the template's.
  // A real place name can legitimately contain an escaped quote (e.g. Hebrew
  // "ע\"ש" -- an abbreviation for "named after") -- [^"]* stops at that
  // escaped quote and truncates the match, producing a false positive that
  // looks like a wrong-destination query when the real string is fine. Match
  // "any char that isn't a bare quote, or an escaped-anything pair" instead.
  const wrongDest = (html.match(/"query":\s*"(?:[^"\\]|\\.)*"/g) || []).filter((q) => !q.includes(`, ${destinationEn}"`));
  if (wrongDest.length) problems.push(`${wrongDest.length} geocode quer${wrongDest.length === 1 ? 'y does' : 'ies do'} not target "${destinationEn}" (e.g. ${wrongDest[0]})`);
  if (problems.length) {
    throw new Error(`Route map QC failed — template leftovers detected:\n  - ${problems.join('\n  - ')}`);
  }
}

// Distinct day colors, cycled if a trip has more days than the base palette.
const DAY_PALETTE = ['#1a7a3c', '#1a5fb4', '#b8860b', '#8e44ad', '#c0392b', '#16a085', '#d35400', '#2c3e50', '#7f8c8d', '#27ae60'];
const VISIT_MIN = { Nature: 90, City: 60, Attraction: 60, Food: 45, Sleep: 0 };

function slugName(name, i) { return slug(name, i); }

// ---- Final_Map (Tab 5): selected points, day-by-day routing -----------------
function renderFinalMap(plan, enrich, input, selection, itinerary, altItinerary) {
  const destination = input.destination;
  const destinationEn = enrich.destinationEn || destination;
  const center = enrich.mapCenter || { lat: 0, lng: 0 };
  const countryCode = (enrich.countryCode || '').toUpperCase() || 'US';
  const tripStartBase = itinerary.base || (enrich.mainCityName || destination);
  const baseAddress = `${enrich.mainCityEn || destinationEn}, ${destinationEn}`;

  // Selected places -> POINTS object keyed by a stable slug id + a name->id map.
  const nameToId = {};
  const POINTS = {};
  selection.selected.forEach((p, i) => {
    const id = slugName(p.name, i);
    nameToId[p.name] = id;
    const domain = (p.sources && p.sources[0]) || '';
    POINTS[id] = {
      id, name: p.name, query: `${p.name}, ${destinationEn}`,
      category: CAT_MAP[p.category] || 'Attraction', rec: !!p.recommended,
      visitMin: VISIT_MIN[CAT_MAP[p.category] || 'Attraction'] || 60,
      desc: p.description || '', source: (p.sources || []).join(' / '),
      url: domain ? (domain.startsWith('http') ? domain : `https://${domain}`) : ''
    };
  });

  // Not-selected places -> EXTRA_REGIONS ("worth knowing about").
  const selectedNames = new Set(selection.selected.map((p) => p.name));
  const EXTRA_REGIONS = plan.regions.map((r) => ({
    region: r.name,
    points: r.places.filter((p) => !selectedNames.has(p.name)).map((p) => ({
      name: p.name, category: CAT_MAP[p.category] || 'Attraction', query: `${p.name}, ${destinationEn}`
    }))
  })).filter((r) => r.points.length);

  // Itinerary days -> DAYS structure; map route names to ids (drop unmatched).
  // Each day keeps its OWN overnight base (a relocating road trip sleeps in a
  // different town some nights) -- baseQuery lets the map chain day N+1's
  // route to start from where day N actually ended up sleeping, instead of
  // routing every day from one fixed trip-wide address.
  // Factored out so Tab 5's route-selector (a second, differently-optimized
  // itinerary for the SAME points) can build a second DAYS array the exact
  // same way, instead of duplicating this logic.
  function buildDaysAndColors(itin) {
    const DAY_COLORS = {};
    const days = (itin.days || []).map((d, idx) => {
      const dayNum = d.day || idx + 1;
      DAY_COLORS[dayNum] = DAY_PALETTE[(dayNum - 1) % DAY_PALETTE.length];
      const route = (d.route || []).map((n) => nameToId[n]).filter(Boolean);
      const restaurants = (d.restaurants || []).map((n) => nameToId[n]).filter(Boolean).map((id) => ({ id, note: 'מסעדה/אוכל' }));
      const base = d.base || tripStartBase;
      // A day's real "origin" for driving directions is more precise than its
      // town: once a specific accommodation was manually designated (Tab 4's
      // sleep-location field/toggle), finalplan.js echoes its exact name back
      // as sleepPointName (see finalplan.js rule 9) -- geocoding THAT instead
      // of "<town>, <country>" starts the day's route from the actual
      // apartment/hotel, not wherever the town's generic center happens to be.
      const baseQuery = d.sleepPointName ? `${d.sleepPointName}, ${destinationEn}` : `${base}, ${destinationEn}`;
      return {
        id: dayNum, label: `יום ${dayNum}`, date: d.dateLabel || `יום ${dayNum}`,
        colorKey: dayNum, base, baseQuery, sleepPointName: d.sleepPointName || null,
        isDeparture: idx === (itin.days.length - 1),
        intro: d.intro || '', route, restaurants, note: d.note || null
      };
    });
    // Second pass (needs every day's baseQuery already resolved): a day whose
    // base is the SAME as tomorrow's is a day-trip out-and-back from a stable
    // accommodation (or day 1 traveling in to that first night's base) -- the
    // map should draw the way back too, not just stop at the last sightseeing
    // point. A day that relocates to a genuinely different base tomorrow (a
    // road-trip leg) should NOT get an artificial return leg -- ending near
    // the new base IS the point of that day. isDeparture days never qualify
    // either (they end at the airport). Every real trip's last day is always
    // isDeparture today (see the unconditional idx===length-1 above), so the
    // "last day, not departure" edge case can't currently occur.
    days.forEach((d, idx) => {
      const next = days[idx + 1];
      d.returnsToBase = !d.isDeparture && !!next && next.baseQuery === d.baseQuery;
    });
    return { days, DAY_COLORS };
  }
  function serializeDays(days) {
    return '[\n' + days.map((d) =>
      `  { id:${d.id}, label:${JSON.stringify(d.label)}, date:${JSON.stringify(d.date)}, color:DAY_COLORS[${d.colorKey}], base:${JSON.stringify(d.base)}, baseQuery:${JSON.stringify(d.baseQuery)}, sleepPointName:${JSON.stringify(d.sleepPointName)}, isDeparture:${d.isDeparture}, returnsToBase:${d.returnsToBase}, intro:${JSON.stringify(d.intro)}, route:${JSON.stringify(d.route)}, restaurants:${JSON.stringify(d.restaurants)}, note:${JSON.stringify(d.note)} }`
    ).join(',\n') + '\n]';
  }

  const { days: DAYS, DAY_COLORS: DAY_COLORS_A } = buildDaysAndColors(itinerary);
  let DAYS_B = null;
  let DAY_COLORS_B = {};
  if (altItinerary) ({ days: DAYS_B, DAY_COLORS: DAY_COLORS_B } = buildDaysAndColors(altItinerary));
  // Colors are deterministic by day NUMBER (DAY_PALETTE[(n-1) % len]), never
  // by which itinerary produced day n -- a key collision between the two
  // variants' color maps is guaranteed identical, not a real conflict, so
  // merging into one shared object is safe.
  const DAY_COLORS = Object.assign({}, DAY_COLORS_A, DAY_COLORS_B);
  const daysJsA = serializeDays(DAYS);
  const daysJsB = DAYS_B ? serializeDays(DAYS_B) : null;

  // Unique overnight towns across the whole itinerary, in first-used order --
  // this is what the checklist and the bed-icon map markers key off of.
  // Deliberately computed from the PRIMARY (max-places) itinerary only, even
  // when a min-km alt variant exists -- these bed markers are a persistent,
  // always-visible map layer independent of the day-tab system, and the two
  // variants could in principle distribute nights across the same allowed
  // sleep bases differently. Not kept in sync with which Tab-5 toggle is
  // active; a known, deliberately deferred limitation (secondary display
  // detail, not a correctness break in the day-by-day view itself).
  const overnightBases = [];
  const nightsByBase = {};
  DAYS.forEach((d) => {
    if (!d.base) return;
    if (!overnightBases.includes(d.base)) overnightBases.push(d.base);
    nightsByBase[d.base] = (nightsByBase[d.base] || 0) + 1;
  });
  const basesJs = JSON.stringify(overnightBases.map((b) => ({ name: b, query: `${b}, ${destinationEn}`, nights: nightsByBase[b] })), null, 2);

  const catColors = { Nature: '#27ae60', City: '#8e44ad', Attraction: '#e67e22', Food: '#c0392b', Sleep: '#1a1a4e', Beach: '#2980b9' };
  const catLabels = { Nature: 'טבע', City: 'עיר', Attraction: 'אטרקציה', Food: 'אוכל', Sleep: 'לינה', Beach: 'חוף' };
  const catIcons = { Nature: '🌲', City: '🛍️', Attraction: '🏛️', Food: '🍽️', Sleep: '🛏️', Beach: '🏖️' };

  // Travel mode between points: driving for a trip with a car (region-scale, the
  // Milan template's WALKING gives absurd hour totals over 100km+ legs), walking
  // for a car-free city trip.
  const hasCar = hasCarTransport(input.transport);
  const travelMode = hasCar ? 'DRIVING' : 'WALKING';
  const travelVerb = hasCar ? 'נסיעה' : 'הליכה';
  const travelIcon = hasCar ? '🚗' : '🚶';
  const travelConsts = `const DESTINATION_NAME = ${JSON.stringify(destination)};\n`
    + `const TRIP_TRAVEL_MODE = ${JSON.stringify(travelMode)};\n`
    + `const TRIP_TRAVEL_VERB = ${JSON.stringify(travelVerb)};\n`
    + `const TRIP_TRAVEL_ICON = ${JSON.stringify(travelIcon)};`;

  let html = readTemplate('final_map.template.html');
  html = html
    .replace(/<title>[\s\S]*?<\/title>/, `<title>מסלול סופי — ${destination}</title>`)
    .replace(/<h2>מסלול מילאנו — [^<]*<\/h2>/, `<h2>מסלול ${destination} — ${input.dates || ''}</h2>`)
    .replace(/const DESTINATION_NAME = '[^']*';/, travelConsts)
    // Inter-point legs: use the trip's travel mode, and label with its verb/icon
    // instead of the hardcoded walking wording.
    .replace(/travelMode: google\.maps\.TravelMode\.WALKING/g, 'travelMode: google.maps.TravelMode[TRIP_TRAVEL_MODE]')
    .replace(/סה"כ הליכה בין הנקודות בכל הטיול/g, 'סה"כ ${TRIP_TRAVEL_VERB} בין הנקודות בכל הטיול')
    .replace(/🚶 \$\{timeText\} הליכה בין הנקודות/g, '${TRIP_TRAVEL_ICON} ${timeText} ${TRIP_TRAVEL_VERB} בין הנקודות')
    .replace(/מחשב זמני הליכה אמיתיים מול Google Maps/g, 'מחשב זמני ${TRIP_TRAVEL_VERB} אמיתיים מול Google Maps')
    .replace(/label: `הליכה \(\$\{formatHebrewDuration\(walkMin \* 60\)\}\)`, muted: true \}\);/g, 'label: `${TRIP_TRAVEL_VERB} (${formatHebrewDuration(walkMin * 60)})`, muted: true });')
    .replace(/const BASE_ADDRESS = '[^']*';/, `const BASE_ADDRESS = ${JSON.stringify(baseAddress)};`)
    .replace(/const BASE_NAME = '[^']*';/, `const BASE_NAME = ${JSON.stringify(tripStartBase)};\nconst OVERNIGHT_BASES = ${basesJs};`)
    .replace(/const CATEGORY_COLORS = \{[^}]*\};/, `const CATEGORY_COLORS = ${JSON.stringify(catColors)};`)
    .replace(/const CATEGORY_LABELS_HE = \{[^}]*\};/, `const CATEGORY_LABELS_HE = ${JSON.stringify(catLabels)};`)
    .replace(/const CATEGORY_ICONS = \{[^}]*\};/, `const CATEGORY_ICONS = ${JSON.stringify(catIcons)};`)
    .replace(/const DAY_COLORS = \{[^}]*\};/, `const DAY_COLORS = ${JSON.stringify(DAY_COLORS)};`)
    .replace(/const POINTS = \{[\s\S]*?\n\};/, `const POINTS = ${JSON.stringify(POINTS, null, 2)};`)
    .replace(/const EXTRA_REGIONS = \[[\s\S]*?\n\];/, `const EXTRA_REGIONS = ${JSON.stringify(EXTRA_REGIONS, null, 2)};`)
    .replace(/const DAYS_VARIANT_A = \[[\s\S]*?\n\];/, `const DAYS_VARIANT_A = ${daysJsA};`)
    .replace(/let DAYS_VARIANT_B = null;/, `let DAYS_VARIANT_B = ${daysJsB || 'null'};`)
    .replace(/const HAS_ROUTE_VARIANTS = false;/, `const HAS_ROUTE_VARIANTS = ${!!daysJsB};`)
    .replace(/center: \{ lat: [\d.\-]+, lng: [\d.\-]+ \}/, `center: { lat: ${center.lat}, lng: ${center.lng} }`)
    .replace(/(maps\.googleapis\.com\/maps\/api\/js\?[^"]*?)&region=[A-Z]{2}/, `$1&region=${countryCode}`)
    .replace(/componentRestrictions: \{ country: '[A-Z]{2}' \}/g, `componentRestrictions: { country: ${JSON.stringify(countryCode)} }`)
    // "Worth knowing about" distances are already cached per d.base (this
    // function's own worthCache[d.base] key proves it knows better) but still
    // measured every leg from the single trip-wide BASE_ADDRESS -- e.g. day 6's
    // "how far is this extra site" number would silently use day 1's city.
    // Use that day's own real overnight base instead.
    .replace(
      /directionsService\.route\(\{\n            origin: BASE_ADDRESS,/,
      'directionsService.route({\n            origin: d.baseQuery,'
    )
    // Bed-icon marker for every real overnight town, so it's visually obvious
    // on the map itself which stops are "sleep here tonight" vs. a same-day
    // visit -- geocoded and dropped once at init, always visible (not tied to
    // the day-tab filter, since a base often spans multiple days).
    .replace(
      /geocodeAllPoints\(\);\n  fetchAllDayRoutes\(\);/,
      'geocodeAllPoints();\n  geocodeOvernightBases();\n  fetchAllDayRoutes();'
    )
    .replace(
      /function geocodeAllPoints\(\) \{/,
      `function geocodeOvernightBases() {
  OVERNIGHT_BASES.forEach((b, i) => {
    setTimeout(() => {
      geocoder.geocode({ address: b.query, componentRestrictions: { country: GEOCODE_COUNTRY } }, (results, status2) => {
        if (status2 === 'OK' && results[0]) {
          const pos = results[0].geometry.location;
          const nightsLabel = b.nights === 1 ? '1 לילה' : (b.nights + ' לילות');
          new google.maps.Marker({
            position: pos,
            map: map,
            title: '🛏 לינה: ' + b.name + ' (' + nightsLabel + ')',
            label: { text: '🛏', fontSize: '16px' },
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: '#1a1a4e', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 },
            zIndex: 999
          });
          // A marker's own label can't fit "Sibiu, 2 לילות" legibly (it's
          // centered ON the icon) -- the same DistanceLabel overlay used for
          // road distances works here too, offset just above the pin.
          if (DistanceLabel) {
            new DistanceLabel(pos, '🛏 ' + b.name + ' (' + nightsLabel + ')').setMap(map);
          }
        }
      });
    }, i * 200);
  });
}

function geocodeAllPoints() {`
    );

  validateFinalMapLeftovers(html, destinationEn);
  return html;
}

// QC guard for the final map, same spirit as the route map's: a leftover
// BASE_ADDRESS-as-origin or an un-rewired 'הדואומו' string would silently
// produce wrong distances for a multi-city trip -- fail loudly instead.
// The chained-origin logic used to be regex-patched in from rendermaps.js;
// it's now baked directly into final_map.template.html's own
// fetchAllDayRoutes (`const origin = di === 0 ? BASE_ADDRESS : ...`), so the
// guard checks for that baseline string instead of a patch having landed.
function validateFinalMapLeftovers(html, destinationEn) {
  const problems = [];
  if (!html.includes('const origin = di === 0 ? BASE_ADDRESS : DAYS[di - 1].baseQuery')) problems.push('per-day chained origin is missing from fetchAllDayRoutes');
  if (/origin: BASE_ADDRESS,\s*\n\s*destination/.test(html)) problems.push('a day route still uses the single fixed BASE_ADDRESS as its origin');
  // HAS_ROUTE_VARIANTS and DAYS_VARIANT_B must always agree on whether a
  // route variant was actually injected -- if only one of the two regex
  // patches lands (e.g. a future edit to one literal without the other), the
  // toggle would show but do nothing, or a real variant B would silently
  // never appear. Catch that mismatch here instead of shipping it.
  const hasVariantsFlag = /const HAS_ROUTE_VARIANTS = true;/.test(html);
  const variantBIsNull = /let DAYS_VARIANT_B = null;/.test(html);
  if (hasVariantsFlag === variantBIsNull) problems.push('HAS_ROUTE_VARIANTS and DAYS_VARIANT_B disagree about whether a route variant was injected');
  // Same escaped-quote fix as the route map's guard -- a name like Hebrew
  // "ע\"ש" (an abbreviation for "named after") is valid JSON but [^"]* alone
  // truncates at the escaped quote and reads as a false positive.
  const wrongDest = (html.match(/"query":\s*"(?:[^"\\]|\\.)*"/g) || []).filter((q) => !q.includes(`, ${destinationEn}"`));
  if (wrongDest.length) problems.push(`${wrongDest.length} query field(s) do not target "${destinationEn}"`);
  if (problems.length) throw new Error(`Final map QC failed — template leftovers detected:\n  - ${problems.join('\n  - ')}`);
  return html;
}

module.exports = { renderRouteMap, renderFinalMap, toRegions, CAT_MAP, hasCarTransport };
