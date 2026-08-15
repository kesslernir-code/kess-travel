// Stage B of the Gemini-based mining pipeline, orchestrated end to end.
// Deliberately a PLAIN NODE SCRIPT, never a `claude -p` call -- this is the
// exact stage that used to run inside Claude (fetch + extract, done by
// mining subagents) and is where every real cost/reliability failure this
// project hit traced back to: async-dispatch thrashing, a model that
// couldn't apply a written call-cap formula, and mining costing $3-4 with
// zero output. Moving it to deterministic code removes that whole class of
// failure -- there's no LLM judgment happening here at all, just HTTP calls.
//
// Input:  <Destination>_Mining_URLs.json  -- { "domain.com": ["url1", "url2", ...], ... }
//         (written by a cheap Claude WebSearch-only step -- see trip-master-plan_SKILL.md)
// Output: <Destination>_Extracted_Points.json -- { destination, extractedAt, points[], skipped[] }
//         (consumed by a cheap Claude step that organizes it into Master_Plan.md)
//
// Usage: node lib/mine_pipeline.js "<Destination>"
// Exit code 0 on completion (even with some per-URL skips -- that's normal),
// non-zero only if the input file is missing/unreadable or GEMINI_API_KEY
// is unset, since those are real setup errors, not per-URL noise.

const fs = require('fs');
const path = require('path');
const { loadEnvLocal } = require('./loadEnv');
const { scrapeToText } = require('./scrape');
const { extractPoints } = require('./gemini');

const ROOT = path.join(__dirname, '..');
loadEnvLocal(ROOT);

// Paces calls to stay comfortably under both Jina Reader's undocumented free
// -tier limit and Gemini 1.5 Flash's free-tier 15 requests/minute cap.
// Sequential + a real delay, not concurrency -- this pipeline runs maybe 40-80
// URLs total per trip; correctness and staying under both rate limits matters
// far more here than shaving a minute off wall-clock time.
const DELAY_BETWEEN_URLS_MS = 4200; // ~14/min, just under Gemini's free-tier 15 RPM

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMiningPipeline(dest) {
  const destDir = path.join(ROOT, dest);
  const urlsPath = path.join(destDir, `${dest}_Mining_URLs.json`);
  const outPath = path.join(destDir, `${dest}_Extracted_Points.json`);

  if (!fs.existsSync(urlsPath)) {
    throw new Error(`${urlsPath} does not exist -- run the URL-discovery step first`);
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set in .env.local');
  }

  const urlsByDomain = JSON.parse(fs.readFileSync(urlsPath, 'utf-8'));
  const allPoints = [];
  const skipped = [];
  let processed = 0;
  const totalUrls = Object.values(urlsByDomain).reduce((sum, urls) => sum + urls.length, 0);

  // Writes the file it builds only once, at the very end -- a real run with
  // 72 URLs across 18 sources ran into the caller's 35-minute hard timeout
  // (a normal foreground `claude -p` step, no bug on that side) and got
  // killed mid-loop. Every point already extracted before the kill was lost,
  // because nothing had been written to disk yet. Writing the accumulated
  // result after every URL instead of only at the end means a kill at any
  // point still leaves a real, partial `_Extracted_Points.json` behind --
  // `inProgress: true` marks it as not-yet-complete so a downstream step
  // can tell a genuine partial result apart from a finished one.
  function flush(inProgress) {
    const result = {
      destination: dest,
      extractedAt: new Date().toISOString(),
      totalUrls,
      processedUrls: processed,
      totalPoints: allPoints.length,
      inProgress,
      points: allPoints,
      skipped
    };
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf-8');
    return result;
  }

  for (const [domain, urls] of Object.entries(urlsByDomain)) {
    for (const url of urls) {
      processed++;
      console.log(`[${processed}/${totalUrls}] ${url}`);
      try {
        const text = await scrapeToText(url);
        const points = await extractPoints(text, dest, url);
        points.forEach((p) => { p.source_domain = domain; });
        allPoints.push(...points);
        console.log(`  -> ${points.length} points`);
      } catch (err) {
        console.error(`  SKIPPED (${err.message})`);
        skipped.push({ domain, url, reason: err.message });
      }
      flush(true);
      // Pace every call, including the last -- simpler than special-casing,
      // and the trailing delay is negligible next to the whole run's length.
      await sleep(DELAY_BETWEEN_URLS_MS);
    }
  }

  const result = flush(false);
  console.log(`\nDone: ${allPoints.length} points from ${totalUrls - skipped.length}/${totalUrls} URLs (${skipped.length} skipped). Wrote ${outPath}`);
  return result;
}

if (require.main === module) {
  const dest = process.argv[2];
  if (!dest) {
    console.error('Usage: node lib/mine_pipeline.js "<Destination>"');
    process.exit(1);
  }
  runMiningPipeline(dest)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('FATAL:', err.message);
      process.exit(1);
    });
}

module.exports = { runMiningPipeline };
