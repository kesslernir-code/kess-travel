# Kess App Test — KESSLER_TRIP (trip_app/) — 2026-08-15

## Summary

Three agents reviewed `trip_app/` — the current, live pipeline — for wasted speed/effort, unnecessary cost, and structural inefficiency. A fourth agent cross-checked every suggestion against what's actually deliberate in this codebase (manual point selection, no-auto-full-runs, the hard-won sequential/throttled image-fetching fix, the template-injection design, etc.). Overall the codebase is in solid shape: no unbounded loops, no accidental paid-API paths, and the things that *look* like inefficiencies at first glance (fully sequential image fetching, no concurrency) turned out to be deliberate, tested fixes for real incidents documented in the code's own comments. 13 suggestions survived as genuine, safe improvements — all 13 landed in "ready to implement," none require changing an approved decision. Two of the 13 (a redundant network call, and a safety-net reliability gap under batch load) were fixed immediately rather than just reported, since they were small, low-risk, and directly relevant to work already in progress this session.

## List 1 — Ready to Implement

No effect on your approved requirements; go ahead.

| Suggested Improvement | Expected Outcome | Source |
|---|---|---|
| ~~Skip the redundant repeat `fetchImageFor` call in `attachImages()`'s highlights fallback~~ **— already fixed this session** | Removes a wasted throttled network round-trip per highlight miss | Agent 1 + Agent 2 |
| Wire up the unused `reuseExtracted`/`reuseItinerary`/`reuseImages` flags in `server.js` | A retry/resubmission of `/confirm-sources` or `/confirm-selection` reuses prior work instead of silently re-paying for a full Gemini extraction or the 25-30 min image pass | Agent 2 |
| Add a server-side idempotency guard on `/new-trip` | Backs up the existing client-side double-submit protection at near-zero cost | Agent 2 (minor) |
| Use compact `JSON.stringify(data)` instead of pretty-printed in organize.js/enrich.js/finalplan.js prompts | Small, free token savings, zero behavior change | Agent 2 (minor) |
| Extract one shared `callGeminiWithRetry`/`getGeminiClient` helper for organize.js/enrich.js/finalplan.js/lib/gemini.js | Fixes two real, already-drifted bugs as a side effect: enrich.js currently has **no retry at all**, and `extractPoints`'s retry regex excludes `"timed out"` while the other two include it | Agent 3 |
| Unify `pointsPerDayFromPace` between `suggest.js` (server) and `route_map.template.html` (client) — inject one canonical table the same way `TRIP_PACE`/`TRIP_DAYS` already are | The two currently use **different numbers** (e.g. intense=6 vs 5), so `test_full.js`'s automated test silently exercises different day-density behavior than real users see in the browser | Agent 3 |
| Factor region-circle-radius math into one shared `computeRegionCircle(locs)` function | One formula instead of two independently-typed copies (currently consistent, but no single source of truth for future tuning) | Agent 3 |
| Share static-file-serving logic between `serve.js` and `server.js` | Fixes an already-real drift: `server.js`'s MIME table includes `.ico`, `serve.js`'s doesn't (favicon 404s in the dev-viewer path) | Agent 3 |
| Delete or annotate 4 dead template files (`checklist.template.html`, `showcase.template.html`, `final_showcase.template.html`, `sources.template.html`, ~877 lines) | Removes a real "is this actually used?" trap — `render.js` fully reimplements these pages inline instead of reading these files | Agent 3 |
| Make `runPipeline()` a thin wrapper over the live per-stage functions instead of a ~100-line reimplementation | Fixes a confirmed real bug as a side effect: `runPipeline` calls `renderSources()` with 2 args instead of 3, baking a literal `http://localhost:undefined/...` into test-generated Sources tabs | Agent 3 |
| Surface background pipeline-stage failures (organize/enrich/buildItinerary throwing) as a visible error state on the dashboard, not just a log line | A real failure (bad API key, Gemini outage) currently looks identical to "still running" — the user has no way to tell without checking a log file | Agent 3 |
| Add a shared `htmlShell(title, extraCss, bodyHtml)` helper for render.js's 5 repeated HTML-boilerplate blocks | Trims ~10-15 lines per function; does not touch the protected map-page template-injection design | Agent 3 (minor) |
| Replace `images.js`'s generic `runPool` with a plain sequential loop, since concurrency is permanently pinned at 1 | Equally correct, less indirection — worth doing only if touching the file for another reason | Agent 3 (minor) |

## List 2 — Recommended, But Changes Your Requirements

None. Every surviving finding stays inside the current architecture and approved decisions — nothing asked to reintroduce image-fetch concurrency, replace the template-injection approach, delete the top-level legacy files, add standing trip-preference defaults, or auto-run a full pipeline without your say-so.

## Not Recommended / Informational Only

- **organize.js sending full `description_long` per point** — deliberate (needed for region/dedup merge judgment), flagged only as something to watch if point counts grow much larger than the ~578 seen in the real Romania run.
- **`trip_watcher.js` as a latent duplicate-cost risk** — only relevant if that legacy top-level file were ever launched alongside the new server; not a `trip_app/` code issue, and it's already covered by the standing "legacy files are reference-only" rule.

## Appendix: Raw Findings by Agent

**Agent 1 (Speed & Effort):** One finding — a redundant, guaranteed-to-fail-identically repeat of `fetchImageFor` in `attachImages()`'s third fallback branch. Everything else checked clean: retry/backoff configs are bounded and sane, sequential loops are correctly recognized as deliberate, no unbounded refinement loops, no busy-waits, caching/reuse options already exist in several places.

**Agent 2 (Cost Efficiency):** Model choice confirmed already-appropriate everywhere (Haiku for discovery, Gemini Flash for extraction/planning). No agentic-loop risk. No accidental paid-API path in images.js (verified it only calls Wikipedia/Commons/Wikidata, never Claude or Gemini). Main finding: reuse flags exist but aren't wired into `server.js`. Minor findings: no server-side `/new-trip` idempotency guard, pretty-printed JSON in prompts.

**Agent 3 (Engineering Efficiency):** Found real drift from copy-paste in 3 separate places (Gemini retry wrapper, pace-to-days-per-region table, static file serving) plus a confirmed live bug in the test harness (`runPipeline`'s wrong-arity `renderSources` call) and 4 genuinely dead template files. No over-complex architecture found — the stage pipeline is proportionate to the problem.
