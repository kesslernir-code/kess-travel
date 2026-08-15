# CLAUDE.md

Guidance for working in this repo.

## What this is

KESSLER_TRIP: a personal AI trip-planning pipeline, run as a **live local web
app** — `trip_app/server.js`, a plain Node `http` server (no Express) on port
8234. Double-clicking the desktop shortcut (`launch_kessler_trip.js` via
`start_kessler_trip.vbs`) starts this server and opens the trip form. Every
pipeline stage is a plain awaited function call in this ONE process — no
file-watcher, no separate `claude -p` session per stage, no cross-process
polling. This replaced an earlier skills-driven architecture (Cowork skills +
`trip_watcher.js` + `local_server.js`) that kept failing unpredictably; that
old system is archived in `Archive_PreRearchitecture/`, kept for reference
only — nothing in it is live or imported by anything current.

## Architecture

Pipeline stages (`trip_app/pipeline/*.js`), each a plain awaited call:

1. **Discover** (`discover.js`) — the ONE place that still shells out to
   `claude -p`, restricted to `--allowedTools WebSearch` only (structurally
   can't background a Bash call or misuse other tools), Haiku model,
   `--max-budget-usd 1`, ~$0.35/destination measured. Reads the standing
   source list from `Knowledge_Hubs.md` at the repo root plus newly-found
   sources, writes `<dest>_discovered_sources.json`.
2. User picks sources on Tab 2 (`Sources.html`, real checkboxes) → POSTs to
   `/confirm-sources`.
3. **Mine** (`run.js`'s `mine()`) — scrapes each chosen URL via Jina Reader
   (`lib/scrape.js`) and extracts points via Gemini (`lib/gemini.js`,
   `gemini-flash-latest`). Paced at 4.2s/URL to respect Gemini's free-tier
   rate limit — deliberate, not a bug.
4. **Organize** (`organize.js`) — one Gemini call: dedupes near-duplicate
   points across sources, groups into named regions.
5. **Enrich** (`enrich.js`) — one Gemini call: tagline, background prose,
   ~12 curated highlights, destination metadata (English name, country code,
   map center).
6. **Images** (`images.js`) — resolves a real photo per place via Wikipedia /
   Wikimedia Commons / Wikidata (all free, unauthenticated). **Must stay
   fully sequential** (`IMAGE_CONCURRENCY = 1`) with a 350ms throttle between
   every request — a direct A/B test proved Wikipedia's search silently
   returns wrong/no results under ANY concurrent burst from one client, not
   just under heavy load. This is the slowest stage (~25-30 min for 100+
   places) and that cost is accepted deliberately: a wrong or generic
   fallback photo violates the "every place has its own picture" requirement,
   and speed was never the priority — accuracy was.
7. **Render** (`render.js`, `rendermaps.js`) — pure templating, no LLM. The
   two map pages (`Route_Map.html`, `Final_Map.html`) are built by regex
   string-injection into hand-authored templates in `trip_app/templates/`
   (`route_map.template.html`, `final_map.template.html`) — this preserves
   exact visual/behavioral parity with the original hand-built pages and is
   guarded by QC checks (`validateNoTemplateLeftovers`,
   `validateFinalMapLeftovers` in `rendermaps.js`) that hard-fail the render
   if injection leaves a stray placeholder. Do not "simplify" this into a
   real templating engine — it's a deliberate, tested design choice. The
   other 5 pages (dashboard, showcase, sources, final showcase, checklist)
   are pure JS template-literal functions in `render.js`, sharing a
   `htmlShell()` helper for the common DOCTYPE/head boilerplate.
8. User picks points on the real Google Map (Tab 4) → POSTs to
   `/confirm-selection`.
9. **Final plan** (`finalplan.js`) — one Gemini call: sequences the confirmed
   points into a day-by-day itinerary, respecting any per-region day-count
   constraints the user set on the map. Each day tracks its OWN overnight
   town (`base`) — a real multi-city road trip's lodging changes day to day,
   this is not one trip-wide value.
10. Render tabs 5-7 (Final_Map, Final_Showcase, Checklist) and the dashboard.

**Reuse flags**: `runMiningStage`/`runFinalPlanStage` (in `run.js`) accept
`reuseExtracted`/`reuseItinerary`/`reuseImages` — `server.js` auto-detects
complete prior output on disk and passes these automatically, so a retried
request never silently re-pays for a Gemini call or redoes the 25-30 min
image pass. `/new-trip` similarly skips discovery if `<dest>_discovered_
sources.json` already exists.

## Standing rules (do not violate without being explicitly asked)

- **Never run a full new-destination pipeline (discovery + mining) unless
  the user explicitly asks.** Both cost real money and take real time.
- **Never delete a past trip's data without explicit instruction.**
- **Point/source selection is manual.** The user checks boxes themselves on
  the map/source list; never auto-select everything.
- **No standing family/trip-preference defaults anywhere.** Every trip's
  parameters come fresh from the form, every time.
- Real trip data lives in `trip_app/trips/<destination>/`. As of this
  writing, `רומניה` (Romania) is the only live, real trip — treat it as real
  user data, not test fixtures.

## Key files at the repo root

- `Knowledge_Hubs.md` — the standing "always check these" source list,
  parsed by `discover.js`. Edit this to add/remove standing sources.
- `New_Trip_Form.html` — the trip-creation form `server.js` serves at `/`.
- `lib/geminiClient.js` — shared Gemini client + retry helper used by every
  Gemini call site (`lib/gemini.js`, `organize.js`, `enrich.js`,
  `finalplan.js`). One retry policy, not four independently-drifting copies.
- `lib/scrape.js` — Jina Reader wrapper with nav-menu stripping and
  blocked-page detection.
- `.env.local` — `GEMINI_API_KEY` + Claude auth. Git-ignored, never commit.
- `Archive_PreRearchitecture/` — the discarded skills-driven system (old
  `CLAUDE_old_architecture.md`, `Skills_Reference/*_SKILL.md`,
  `trip_watcher.js`, `local_server.js`, old Slovenia/Milano trip outputs used
  as design references during the original build). Reference only — nothing
  here is imported by `trip_app/` or should be treated as current guidance.

## Environment gotchas (this machine)

- `node` is at `C:\Program Files\nodejs\node.exe` — not reliably on PATH for
  non-interactive tool contexts; call it by full path from scripts.
- **Do not read UTF-8/JSON with PowerShell `Get-Content`** — it decodes as
  CP1255 here and mangles Hebrew into mojibake. Use `node` or
  `Invoke-RestMethod`.
- This project is NOT a git repository.

## Testing a change

```
node trip_app/server.js              # start the live server, port 8234
node trip_app/test_full.js           # automated 2-source test run (real mining, costs money)
node trip_app/test_full.js --reuse   # same, but skip re-mining if a prior extraction exists
```

To verify a render-only change without spending on mining/images again, call
the relevant `render*`/`renderRouteMap`/`renderFinalMap` function directly
against an existing trip's on-disk JSON (see this session's approach: read
`<dest>_master_plan.json`/`_enrich.json`/`_itinerary.json`/`_selection.json`,
call the render function, write the result back over the existing HTML file).

## Behavioral guidelines to reduce common LLM coding mistakes

**Tradeoff:** these bias toward caution over speed. For trivial tasks, use judgment.

1. **Think before coding.** State assumptions explicitly. If multiple
   interpretations exist, present them — don't pick silently. If something's
   unclear, stop and ask.
2. **Simplicity first.** Minimum code that solves the problem. No features
   beyond what was asked, no speculative abstractions, no error handling for
   impossible scenarios.
3. **Surgical changes.** Touch only what you must. Don't refactor unrelated
   code. Match existing style. Remove imports/variables your OWN changes
   made unused; don't remove pre-existing dead code unless asked.
4. **Goal-driven execution.** Turn tasks into verifiable goals ("fix the bug"
   → "write a test that reproduces it, then make it pass") and loop
   independently against a clear success criterion rather than asking for
   constant confirmation.
