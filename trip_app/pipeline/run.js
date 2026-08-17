// Orchestrator: destination + input + chosen sources -> all artifacts.
//
// This is the whole pipeline, run IN ONE NODE PROCESS, top to bottom, awaiting
// each stage. No `claude -p`, no file-watcher, no cross-process confirm hack,
// no timeout that kills work mid-flight. Every stage is a plain awaited call;
// if one throws, the run stops with a real error instead of silently logging
// a false success. This is the structural fix for every failure the old
// skills-driven flow hit.
//
// Stages: mine (scrape + Gemini extract, per URL) -> organize (one Gemini call)
//         -> render (pure templating). Only the first two cost anything; both
//         are Gemini, cents-scale.

const fs = require('fs');
const path = require('path');
const { loadEnvLocal } = require('../../lib/loadEnv');
const { scrapeToText } = require('../../lib/scrape');
const { extractPoints } = require('../../lib/gemini');
const { organizePoints } = require('./organize');
const { enrichPlan } = require('./enrich');
const { attachImages, attachImagesToPlaces, resolveImageGuaranteed } = require('./images');
const { renderMasterPlanMd, renderDashboard, renderShowcase, renderSources, renderFinalShowcase, renderChecklist } = require('./render');
const { renderRouteMap, renderFinalMap } = require('./rendermaps');
const { suggestSelection } = require('./suggest');
const { buildItinerary } = require('./finalplan');
const { discoverSources, discoverMoreSources, SOURCE_TYPES } = require('./discover');

const ROOT = path.join(__dirname, '..', '..');
loadEnvLocal(ROOT);

const TRIPS_DIR = path.join(__dirname, '..', 'trips');
const DELAY_BETWEEN_URLS_MS = 4200; // stay under Gemini's free-tier 15 RPM

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function nowStamp() { return new Date().toISOString(); }

function tripDir(destination) { return path.join(TRIPS_DIR, destination); }
function ensureTripDir(destination) {
  const dir = tripDir(destination);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeJson(dir, name, obj) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2), 'utf-8');
}
function writeText(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text, 'utf-8');
}

// Stage 1 -- mine every URL of every chosen source. Writes the growing result
// after each URL, exactly like the standalone pipeline's incremental-flush fix,
// so a crash/kill mid-run still leaves a real partial file behind.
async function mine(destination, sources, dir, onProgress) {
  const points = [];
  const skipped = [];
  const allUrls = [];
  for (const s of sources) for (const u of (s.urls || [])) allUrls.push({ domain: s.domain, url: u });
  const total = allUrls.length;
  let processed = 0;

  const flush = (inProgress) => writeJson(dir, `${destination}_Extracted_Points.json`, {
    destination, extractedAt: nowStamp(), totalUrls: total, processedUrls: processed,
    totalPoints: points.length, inProgress, points, skipped
  });

  for (const { domain, url } of allUrls) {
    processed++;
    if (onProgress) onProgress(`[${processed}/${total}] ${url}`);
    try {
      const text = await scrapeToText(url);
      const got = await extractPoints(text, destination, url);
      got.forEach((p) => { p.source_domain = domain; });
      points.push(...got);
      if (onProgress) onProgress(`  -> ${got.length} points`);
    } catch (err) {
      skipped.push({ domain, url, reason: err.message });
      if (onProgress) onProgress(`  SKIPPED (${err.message})`);
    }
    flush(true);
    await sleep(DELAY_BETWEEN_URLS_MS);
  }
  flush(false);
  return { points, skipped, total };
}

// ============================================================================
// LIVE STAGES -- called by server.js with REAL user input (form submission,
// real checkbox picks, real map clicks), unlike runPipeline() below which is
// the automated test harness (auto-suggests picks, reuses old test URLs).
// Each stage reads back whatever the previous one wrote to disk instead of
// relying on in-memory state, so a server restart between stages (a real
// possibility -- the gap between "pick sources" and "pick points" can be
// minutes or hours of a human actually looking at the map) doesn't lose work.
// ============================================================================

// Stage A1: find real sources for a destination the app has never seen before.
// destination = the folder-safe key (usually same as input.destination for a
// fresh trip); input = the parsed trip-form fields.
async function runDiscoveryStage(destination, input, serverPort, onProgress) {
  const log = onProgress || (() => {});
  const dir = ensureTripDir(destination);
  writeJson(dir, `${destination}_input.json`, input);
  writeText(dir, `${destination}_KESSLER_TRIP.html`, renderDashboard(destination, input, {}));

  log('== discovering sources ==');
  const { sources, costUsd } = await discoverSources(input.destination || destination, input.destinationEn || null, log);
  if (!sources.length) throw new Error('No relevant sources were found for this destination -- nothing to mine.');

  writeJson(dir, `${destination}_discovered_sources.json`, { destination, discoveredAt: nowStamp(), costUsd, sources });
  writeText(dir, `${destination}_Sources.html`, renderSources(input.destination || destination, sources, serverPort, SOURCE_TYPES));
  writeText(dir, `${destination}_KESSLER_TRIP.html`, renderDashboard(destination, input, { 2: true }));
  log(`discovery done: ${sources.length} sources, $${costUsd.toFixed(4)}`);
  return { sources, costUsd };
}

// Targeted top-up: the user marked specific categories as "not enough
// sources" on the Sources page and asked for more, instead of quietly
// accepting the original discovery pass as final. Appends to the existing
// discovered_sources.json (never replaces it) and re-renders Tab 2 only --
// mining/organize/enrich haven't run yet at this point in a fresh trip, so
// there's nothing else to touch.
async function runExpandSourcesStage(destination, categories, serverPort, onProgress) {
  const log = onProgress || (() => {});
  const dir = ensureTripDir(destination);
  const inputPath = path.join(dir, `${destination}_input.json`);
  const discoveredPath = path.join(dir, `${destination}_discovered_sources.json`);
  if (!fs.existsSync(inputPath) || !fs.existsSync(discoveredPath)) throw new Error('Trip input / discovered sources missing -- run discovery first.');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
  const discovered = JSON.parse(fs.readFileSync(discoveredPath, 'utf-8'));

  log('== searching for additional sources ==');
  const { sources: newSources, costUsd } = await discoverMoreSources(
    input.destination || destination, input.destinationEn || null, categories, discovered.sources, log
  );
  const mergedSources = discovered.sources.concat(newSources);
  writeJson(dir, `${destination}_discovered_sources.json`, {
    destination, discoveredAt: discovered.discoveredAt, costUsd: (discovered.costUsd || 0) + costUsd, sources: mergedSources
  });
  writeText(dir, `${destination}_Sources.html`, renderSources(input.destination || destination, mergedSources, serverPort, SOURCE_TYPES));
  log(`expand done: ${newSources.length} new sources added ($${costUsd.toFixed(4)})`);
  return { newSources, sources: mergedSources };
}

// Stage A2: mine only the sources the user actually approved on Tab 2, then
// organize/enrich/render tabs 1-4. chosenDomains = string[] from the real
// confirm-sources POST body.
async function runMiningStage(destination, input, chosenDomains, serverPort, onProgress, opts = {}) {
  const log = onProgress || (() => {});
  const dir = ensureTripDir(destination);
  const discoveredPath = path.join(dir, `${destination}_discovered_sources.json`);
  if (!fs.existsSync(discoveredPath)) throw new Error('No discovered sources on file -- run discovery first.');
  const discovered = JSON.parse(fs.readFileSync(discoveredPath, 'utf-8'));
  const chosenSet = new Set(chosenDomains);
  const sources = discovered.sources.filter((s) => chosenSet.has(s.domain));
  if (!sources.length) throw new Error('None of the confirmed domains matched a discovered source.');
  writeJson(dir, `${destination}_sources.json`, sources);

  // reuseExtracted: skip the (paid, slow) re-scrape when a complete extraction
  // already exists on disk -- for re-running organize/enrich/render after a
  // downstream fix, without re-mining 30+ URLs again.
  let points, skipped, total;
  const extractedPath = path.join(dir, `${destination}_Extracted_Points.json`);
  if (opts.reuseExtracted && fs.existsSync(extractedPath)) {
    const prev = JSON.parse(fs.readFileSync(extractedPath, 'utf-8'));
    if (prev && prev.inProgress === false) {
      points = prev.points; skipped = prev.skipped || []; total = prev.totalUrls || points.length;
      log(`== mining (reused ${points.length} points from prior extraction) ==`);
    }
  }
  if (!points) {
    log('== mining ==');
    ({ points, skipped, total } = await mine(destination, sources, dir, log));
    log(`mined ${points.length} points from ${total - skipped.length}/${total} URLs`);
  }

  log('== organizing ==');
  const plan = await organizePoints(points, destination);
  for (const r of plan.regions) for (const p of r.places) {
    p.recommended = !!p.recommended || (Array.isArray(p.sources) && p.sources.length >= 2);
  }
  writeJson(dir, `${destination}_master_plan.json`, plan);

  log('== enriching ==');
  const enrich = await enrichPlan(plan, input.destination || destination);
  await attachImages(enrich.highlights || [], log, enrich.destinationEn || input.destination || destination);
  let fallbackImg = await resolveImageGuaranteed(enrich.mainCityEn || enrich.destinationEn || destination, enrich.destinationEn || destination, null);
  if (!fallbackImg) fallbackImg = ((enrich.highlights || []).find((h) => h.image) || {}).image || null;
  (enrich.highlights || []).forEach((h) => { if (!h.image) h.image = fallbackImg; });
  enrich._fallbackImg = fallbackImg; // stashed for stage B's guaranteed-image fill
  writeJson(dir, `${destination}_enrich.json`, enrich);

  log('== rendering ==');
  const meta = { builtAt: new Date().toLocaleDateString('he-IL'), sourceCount: sources.length, pointCount: points.length };
  writeText(dir, `${destination}_Master_Plan.md`, renderMasterPlanMd(plan, meta));
  writeText(dir, `${destination}_Showcase.html`, renderShowcase(input.destination || destination, enrich));
  writeText(dir, `${destination}_Route_Map.html`, renderRouteMap(plan, enrich, input, serverPort));
  writeText(dir, `${destination}_KESSLER_TRIP.html`, renderDashboard(destination, input, { 2: true, 3: true, 4: true }));

  const regionCount = plan.regions.length;
  const placeCount = plan.regions.reduce((s, r) => s + r.places.length, 0);
  log(`mining stage done: ${placeCount} places in ${regionCount} regions`);
  return { plan, enrich, placeCount, regionCount };
}

// Stage B: build the final day-by-day plan from the REAL points the user
// clicked and confirmed on the map (not an auto-suggestion). clientPoints =
// the real POST body's `points` array: [{id, name, category, region, rec,
// isSleep}, ...] -- exactly what route_map.template.html's onConfirm() sends.
// opts.reuseItinerary/reuseImages: skip the paid/slow itinerary-building
// Gemini call and/or the (free but slow -- ~109 places took 25 min) image
// resolution pass when a prior run already produced them, so a rendering-only
// fix doesn't force redoing either. A real run needed exactly this after a
// render-time bug was caught 25 minutes into image fetching.
async function runFinalPlanStage(destination, input, clientPoints, onProgress, opts = {}) {
  const log = onProgress || (() => {});
  const dir = ensureTripDir(destination);
  const planPath = path.join(dir, `${destination}_master_plan.json`);
  const enrichPath = path.join(dir, `${destination}_enrich.json`);
  if (!fs.existsSync(planPath) || !fs.existsSync(enrichPath)) throw new Error('Master plan / enrich data missing -- run the mining stage first.');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf-8'));
  const enrich = JSON.parse(fs.readFileSync(enrichPath, 'utf-8'));

  // Look up each clicked point's full place object by name (the map's `name`
  // field is copied verbatim from the plan, so this is an exact match).
  // isSleep is a client-only concept (the user manually toggled it) that
  // doesn't exist on the mined place object, so it's attached here rather
  // than looked up. cp.custom = true is a region's manually-entered "final
  // accommodation" point (route_map.template.html's per-region sleep-location
  // field) -- it was typed by the user, not mined from any source, so it has
  // no entry in byName at all; build its place object straight from the
  // client payload instead of dropping it like a genuine no-match would be.
  const byName = {};
  for (const r of plan.regions) for (const p of r.places) byName[p.name] = { ...p, regionName: r.name };
  let selected = clientPoints
    .map((cp) => {
      if (byName[cp.name]) return { ...byName[cp.name], isSleep: !!cp.isSleep };
      if (cp.custom) return { name: cp.name, regionName: cp.region, category: cp.category || 'Sleep', recommended: false, description: '', sources: [], isSleep: true, custom: true };
      return null;
    })
    .filter(Boolean);
  if (!selected.length) throw new Error('None of the confirmed points matched a place in the master plan.');

  // Re-attach previously-resolved images by name, if reusing and available --
  // this is the expensive part to redo (rate-limited Wikipedia lookups).
  const selectionPath = path.join(dir, `${destination}_selection.json`);
  if (opts.reuseImages && fs.existsSync(selectionPath)) {
    const prevSelection = JSON.parse(fs.readFileSync(selectionPath, 'utf-8'));
    const imageByName = {};
    (prevSelection.selected || []).forEach((p) => { if (p.image) imageByName[p.name] = p.image; });
    selected.forEach((p) => { if (imageByName[p.name]) p.image = imageByName[p.name]; });
  }

  const usedRegions = [...new Set(selected.map((p) => p.regionName))];
  const selection = { selected, usedRegions };

  let itinerary;
  const itineraryPath = path.join(dir, `${destination}_itinerary.json`);
  if (opts.reuseItinerary && fs.existsSync(itineraryPath)) {
    itinerary = JSON.parse(fs.readFileSync(itineraryPath, 'utf-8'));
    log(`== building itinerary (reused ${itinerary.days.length}-day itinerary) ==`);
  } else {
    log(`== building itinerary for ${selected.length} confirmed points ==`);
    itinerary = await buildItinerary(selected, input, enrich, opts.regionDays);
    writeJson(dir, `${destination}_itinerary.json`, itinerary);
  }

  const stillNeedImages = selected.filter((p) => !p.image);
  if (stillNeedImages.length) {
    log(`== images for chosen places (${stillNeedImages.length} still needed) ==`);
    await attachImagesToPlaces(stillNeedImages, enrich.destinationEn || input.destination || destination, log);
  } else {
    log('== images for chosen places (all reused) ==');
  }
  const fallbackImg = enrich._fallbackImg || ((enrich.highlights || []).find((h) => h.image) || {}).image || null;
  selected.forEach((p) => { if (!p.image) p.image = fallbackImg; });

  // Persist images (and isSleep) alongside the selection now, so a future
  // render-only retry (opts.reuseImages) never has to redo the image pass
  // again, and a returning visit to Tab 4 can show which points were
  // marked as official sleep bases last time.
  const savedSelected = selected.map((p) => ({ name: p.name, region: p.regionName, category: p.category, recommended: !!p.recommended, image: p.image || null, isSleep: !!p.isSleep, custom: !!p.custom }));
  writeJson(dir, `${destination}_selection.json`, { destination, confirmedAt: nowStamp(), selectedCount: selected.length, selected: savedSelected, regionDays: opts.regionDays || {} });

  log('== rendering final plan ==');
  writeText(dir, `${destination}_Final_Map.html`, renderFinalMap(plan, enrich, input, selection, itinerary));
  writeText(dir, `${destination}_Final_Showcase.html`, renderFinalShowcase(input.destination || destination, enrich, itinerary, selection));
  writeText(dir, `${destination}_Checklist.html`, renderChecklist(input.destination || destination, itinerary, selection));
  // Also refresh Tab 4 itself -- a user returning to "update the trip" should
  // see their actual last confirmed selection (and sleep designations)
  // reflected, not a reset-to-blank "everything checked" master list.
  writeText(dir, `${destination}_Route_Map.html`, renderRouteMap(plan, enrich, input, opts.serverPort || 8234, savedSelected, opts.regionDays));
  writeText(dir, `${destination}_KESSLER_TRIP.html`, renderDashboard(destination, input, { 2: true, 3: true, 4: true, 5: true, 6: true, 7: true }));

  log(`final plan done: ${itinerary.days.length}-day itinerary`);
  return { itinerary, selection };
}

// Full pipeline -- a THIN WRAPPER over the exact same live-stage functions
// server.js calls for a real user (runMiningStage, runFinalPlanStage), used
// only by test_full.js and the CLI block below. This used to reimplement the
// whole mine->organize->enrich->render sequence itself, and the duplication
// had already produced a real, confirmed bug: it called the 2-arg
// `renderSources(dest, sources)` while the live path calls the 3-arg version
// with `serverPort` -- renderSources embeds that port directly into the
// generated page's SERVER_URL string, so a run through here baked a literal
// "http://localhost:undefined/confirm-sources" into the test's Sources tab.
// `trip` = { destination, input, sources }. Discovery itself is skipped (the
// test harness supplies a fixed `sources` list instead of paying for a real
// claude -p discovery call) -- everything after that is the real pipeline.
async function runPipeline(trip, onProgress, opts = {}) {
  const { destination, input, sources } = trip;
  const log = onProgress || (() => {});
  const dir = ensureTripDir(destination);
  const serverPort = opts.serverPort || 8234;

  writeJson(dir, `${destination}_input.json`, input);
  writeJson(dir, `${destination}_discovered_sources.json`, { destination, discoveredAt: nowStamp(), costUsd: 0, sources });
  writeText(dir, `${destination}_KESSLER_TRIP.html`, renderDashboard(destination, input, {}));

  const { plan, enrich, placeCount, regionCount } = await runMiningStage(
    destination, input, sources.map((s) => s.domain), serverPort, log, { reuseExtracted: opts.reuseExtracted }
  );

  // Final plan (Tabs 5-7). In the live app this runs after the user picks
  // points on the map; for the automated test we stand in for that with the
  // same selection the map's "suggest" button would produce.
  let itinerary = null;
  if (opts.buildFinalPlan !== false) {
    const selection = opts.selection || suggestSelection(plan, input);
    log(`selected ${selection.selected.length} points across ${selection.usedRegions.length} regions`);
    const clientPoints = selection.selected.map((p) => ({ name: p.name }));
    ({ itinerary } = await runFinalPlanStage(destination, input, clientPoints, log, { regionDays: opts.regionDays }));
  }

  log(`done: ${placeCount} places in ${regionCount} regions${itinerary ? `, ${itinerary.days.length}-day itinerary` : ''}`);
  return { destination, dir, regionCount, placeCount, days: itinerary ? itinerary.days.length : 0 };
}

// ---- CLI: 1-source flow test ----------------------------------------------
// node trip_app/pipeline/run.js  ->  runs the whole spine on ONE source (a
// couple of real Georgia URLs) so the flow can be validated end-to-end for a
// few cents before scaling to all sources.
if (require.main === module) {
  const testTrip = {
    destination: 'גאורגיה-בדיקה',
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
    sources: [
      {
        name: 'Atlas Obscura', domain: 'atlasobscura.com', tier: 'medium',
        urls: [
          'https://www.atlasobscura.com/things-to-do/country-of-georgia',
          'https://www.atlasobscura.com/things-to-do/tbilisi-georgia'
        ]
      }
    ]
  };
  const reuse = process.argv.includes('--reuse');
  runPipeline(testTrip, (m) => console.log(m), { reuseExtracted: reuse })
    .then((r) => { console.log('\nOK:', JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((err) => { console.error('\nFATAL:', err.message); process.exit(1); });
}

module.exports = {
  runPipeline, mine,
  runDiscoveryStage, runMiningStage, runFinalPlanStage, runExpandSourcesStage,
  ensureTripDir, tripDir, writeJson, writeText
};
