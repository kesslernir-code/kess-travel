---
name: trip-master-plan
description: "Stage 3 of the KESSLER_TRIP pipeline. Mines a trip-scan source list into a comprehensive, categorized master list of places (by region, then Nature/Urban/Attractions/Other, with a star on standout places) -- then immediately turns that inventory into an interactive Google Maps HTML page where the user visually picks which places make the trip (color-coded markers, a synced checklist, click-to-open descriptions, a confirm button that locks the selection as a plain list). The map populates Tab 4 of the destination's KESSLER_TRIP dashboard, then it auto-continues into destination-showcase (Tab 3). Does not sequence a route, pick sleep bases, or compute driving times between legs -- that's a later skill's job. Use whenever the user wants to run 'Trip Master Plan' / 'טריפ מאסטר פלאן', or wants the full place inventory and selection map built after trip-scan has run."
---

# Trip Master Plan

Stage 3 of the KESSLER_TRIP pipeline: [[new-trip-input]] (Tab 1) → [[trip-scan]] (Tab 2, sources) → **this skill** (master list + selection map, map shown in Tab 4) → [[destination-showcase]] (Tab 3) → [[final-trip-planner]] (Tab 5, Tab 6, Tab 7). Note the tab numbering doesn't match run order — Tab 3 and Tab 4 were deliberately swapped so the dashboard reads inspiration-then-tool (Showcase before map) even though this skill runs first. This skill does two things back to back: it mines trip-scan's sources into a full categorized place inventory (Part A), then turns that inventory straight into an interactive map the user curates visually (Part B). Everything downstream — a real day-by-day itinerary, driving times, sleep-base sequencing — gets built later by a skill that consumes whatever the user selects on this map. Don't try to do that later step's job here.

**IMPORTANT — this file documents BOTH halves (Part A and Part B).** If your environment only has an installed skill that covers Part A (mining the source list into a Master Plan document), you must still perform Part B (building the interactive map + local-server wiring) yourself, manually, following the instructions below — it is just as much a required part of this stage as Part A.

**In the headless pipeline (`trip_watcher.js`), Part A and Part B run as two separate `claude -p` sessions with separate budgets, not one combined session.** If you're invoked for Part A only, read `<Destination>_Master_Plan.md` back from disk in the Part B session rather than assuming it's still in conversation context — it isn't, the sessions don't share memory, same as every other skill-to-skill handoff in this pipeline. Don't redo Part A's mining in a Part B-only invocation just because the destination or source list is mentioned in the prompt.

**Architecture note (real, forced change): Part A's actual page-reading and extraction no longer happens inside Claude at all.** The original design had Claude itself (via parallel Haiku subagents) `WebFetch` every source page and extract places directly — that's where essentially every real cost and reliability failure in this whole pipeline traced back to: a subagent silently defaulting to an expensive model, async-dispatch-and-poll thrashing, a model failing to apply a written cost-cap formula, and mining simply costing more in Claude tokens than the budget allowed, twice, with zero output either time ($3.01 then $4.26, both total losses). Part A is now three steps instead of one: **Claude finds candidate URLs (WebSearch only, no WebFetch) → a plain Node script (`lib/mine_pipeline.js`, zero LLM cost during the actual mining) scrapes each URL and extracts structured points via Gemini 1.5 Flash → Claude reads the already-clean, already-structured result and organizes it into `Master_Plan.md`.** No raw page content and no per-domain call-count arithmetic ever reaches Claude's own context anymore — that's the entire point.

**Two things this skill deliberately does NOT do:**
- It does not search the web for new sources, and it does not pull content from domains outside the source list. `WebSearch` (used only in Step 2 below, for URL discovery) is allowed here for exactly one purpose: locating deep pages *on a listed source's own domain* (`site:<listed-domain> <destination> ...`) when `Sources.md` gave only a domain. Never run an open query ("best hidden gems in X"). If the input source list seems thin, that's a signal to go back and run trip-scan again — not a license to go find your own sources here.
- It does not filter, prioritize, sequence into a route, or schedule anything by trip dates, trip length, or who's traveling. Even knowing the user's travel profile (e.g. from a project's CLAUDE.md), that's not this skill's business — capture everything the sources offer in Part A, and let the map's confirm button in Part B be where the user (not you) decides what actually fits their trip. Confirming a selection locks it in as a plain list — it does not build a route.

## Part A — Build the master list

### Step 1 — Find the confirmed source selection

Look in the current project/working folder for `<Destination>_Sources.md` (produced by trip-scan). If it doesn't exist, tell the user to run trip-scan for this destination first rather than improvising a source list yourself — this skill's whole value is in only using pre-vetted sources.

**Then look for `<Destination>_Sources_Selected.json`** (written automatically when the user checked which sources to use on `<Destination>_Sources.html`'s Tab 2 and clicked confirm — see trip-scan's Step 5). This is the real gate on what you're allowed to mine, the same way `<Destination>_Selection.json` gates the final-trip-planner stage:

- **If it exists**, mine **only** the domains listed in its `domains` array — cross-reference each against `Sources.md`'s "Sources to use" list to get that source's full one-line coverage note. Never mine a source that isn't in this file, even if it's sitting right there in `Sources.md` — the user deliberately left it unchecked, and that's the whole point of the confirm step. It's fine (and expected) for this to be a small subset of `Sources.md`'s full list.
- **If it doesn't exist yet**, do not proceed and do not improvise a default selection — stop here and say plainly that source selection hasn't been confirmed on Tab 2 yet. This mirrors exactly how final-trip-planner refuses to build a route before `Selection.json` exists; don't special-case this stage into skipping that same discipline just because it comes earlier in the pipeline.

### Step 2 — Find URLs to mine per domain (WebSearch only — no WebFetch, no extraction)

For each confirmed domain, find up to **~5 candidate deep-link URLs** worth scraping — not just the domain's homepage. Aim for a spread that covers different angles, since there's no multi-round mining anymore to layer this depth in later:

- The domain's main destination overview / "things to do" page for `<Destination>`.
- If search results surface them: a hiking/trekking-specific page, a food/wine-specific page, a "hidden gems"/local-tips page, or a specific region/city sub-page — whichever the source actually seems to have, don't force all five slots to exist for every domain.

Use `WebSearch` in the form `site:<domain> <destination> ...` (English or Hebrew as fits the source's language) to find these — **never `WebFetch` in this step.** This step's entire job is compiling a URL list, not reading anything. If `Sources.md`/`Knowledge_Hubs.md` already names a specific deep link for a domain, include it without needing to search for it again.

Write `<Destination>_Mining_URLs.json`:
```json
{
  "masa.co.il": ["https://masa.co.il/some-georgia-overview-page"],
  "journalofnomads.com": ["https://.../georgia-hiking-guide", "https://.../tbilisi-things-to-do"]
}
```
A domain that genuinely turns up nothing findable can have an empty array — don't force a bad URL in just to fill the list.

### Step 2b — Run the extraction pipeline (deterministic, not an LLM call)

Run, via the Bash tool, from the Trip Planner root:
```
node lib/mine_pipeline.js "<Destination>"
```
This scrapes every URL from Step 2 (Jina Reader → clean text) and extracts structured points via Gemini 1.5 Flash — see `lib/mine_pipeline.js`, `lib/scrape.js`, `lib/gemini.js` for the actual implementation. **Just run it and wait for it to finish** — it paces itself under both services' rate limits, so a normal run (30-50 URLs) takes a few minutes of wall-clock time but costs essentially nothing in Claude tokens, since you're only blocked on a Bash call, not generating anything.

**This Bash call must run in the foreground with an explicit long timeout, and you must not end your turn until it actually exits.** This skill runs as a non-interactive, single-shot `-p` session — there is no later turn to come back to, no matter what mechanism seems to promise one. Two separate real runs got this wrong in two different ways, both with the same result (the process ended, the pipeline was abandoned mid-run, `Extracted_Points.json`/`Master_Plan.md` were never written, and the run still cost real money for nothing):

- One run called Bash with `run_in_background: true`, wrote "Mining pipeline is running in the background, I'll continue once it finishes," and ended its turn.
- Another run avoided `run_in_background` but instead reached for the `Monitor` tool, reasoning it would "be notified when the mining pipeline finishes," and ended its turn waiting on that notification.

Both are the same mistake wearing a different mechanism: **there is no notification, no background check-in, and no next turn in a one-shot `-p` session.** Backgrounding, `Monitor`, `ScheduleWakeup`, or any other "come back to this later" tool is categorically wrong for this call, regardless of how it's framed. The only correct move is a single, ordinary, foreground Bash call that you wait on synchronously — if you haven't watched the command exit and read its output yourself, in this same turn, the run did not happen. Pass an explicit `timeout` of up to 600000 (10 minutes) on the Bash call itself — the tool's default (2 minutes) is shorter than a normal 30-50-URL run and will cut it off. If a batch is large enough that even a 10-minute foreground call isn't enough, that's a real signal to look at trimming Step 2's URL list, not a reason to reach for any of these tools.

It writes `<Destination>_Extracted_Points.json` — `{ destination, extractedAt, totalUrls, totalPoints, points: [...], skipped: [...] }`, where each point has `name`, `description` (≤20 words, for the map bubble in Part B — not what you write into the Master Plan), `description_long` (2-4 sentences, everything the source actually said about it — **this is the field Step 4 uses for the Master Plan's write-up**), `category` (`Nature`/`Urban`/`Attraction`/`Food`/`Sleep`/`Other`), `recommended`, `location_mentioned`, `coordinates`, `source_url`, `source_domain`.

**If the command errors** (most likely cause: `GEMINI_API_KEY` missing from `.env.local`) — stop and say so plainly. Do not fall back to writing a Master Plan from general knowledge; that defeats the entire point of this pipeline exactly as much as it would have under the old Claude-mining design.

**If `skipped` is non-empty**, that's normal (a page Jina Reader couldn't fetch, or a Gemini call that timed out) — note briefly which URLs were skipped and why, but don't treat it as a failure requiring a retry loop.

### Step 2c — Record source efficiency (required, every trip)

Read `Source_Efficiency.json` in the project folder (create it with just `{"_readme": "..."}` if it doesn't exist yet). For every domain mined this trip, compute from `<Destination>_Extracted_Points.json`: `callsThisTrip` = the number of URLs mined for that domain (from `<Destination>_Mining_URLs.json`), `placesThisTrip` = the number of points in `Extracted_Points.json` whose `source_domain` matches. Add both to that domain's running totals, recompute `callsPerPlace` (`totalCalls / totalPlacesFound`), increment `timesEvaluated`, and set `lastEvaluated` to today.

Set `verdict` to `"low-efficiency"` when `callsPerPlace > 5` after at least 2 evaluations (so one unusually thin trip doesn't condemn a source) — otherwise `"efficient"`. Write the file back. This is the persistent record trip-scan's Step 2 reads on every future trip to decide whether a source stays in `Knowledge_Hubs.md` at all.

**Cost estimate: this pipeline's real per-domain cost is now near-zero** (Jina Reader is free; Gemini 1.5 Flash's free tier — 15 requests/min, 1500/day — covers a normal trip's URL volume outright in most cases). The old `$0.015`-per-call Claude-mining heuristic no longer applies at all — don't reuse it. Write `estimatedCostPerTripUsd` as a nominal `0.01` flat (covering the rare case of spilling past the Gemini free tier into paid usage, which is priced low enough not to matter) rather than computing a per-call estimate the way the old architecture did. The `callsPerPlace` efficiency signal (a domain yielding very few real points per URL scraped) is now purely a **quality** signal for whether a domain is worth including in future URL-discovery, not a cost one.

### Step 3 — Organize, dedupe, and categorize

Read `<Destination>_Extracted_Points.json`. Two things need real judgment here that Gemini's per-URL extraction couldn't do on its own (it only ever saw one page at a time):

1. **Dedupe across sources.** The same place is very likely named by more than one source's URL (e.g. "מבצר נריקלה" from three different blogs) — merge these into one entry, keep the richest/most specific description among the duplicates, and combine source attribution (e.g. "מקור: Red Fedora Diary, Journal of Nomads"). Match on name similarity, not exact string equality — allow for transliteration differences (Narikala / נריקלה) and minor phrasing differences.
2. **Group by the destination's natural geographic regions**, then re-map Gemini's six categories into exactly four buckets per region:

- **טבע (Nature)** ← `Nature`
- **אורבני (Urban)** ← `Urban`
- **אטרקציות (Attractions)** ← `Attraction`
- **אחר (Other)** ← `Food`, `Sleep`, `Other` (sleep-base candidates get identified properly later, in Part B — don't try to solve that here just because Gemini tagged something `Sleep`)

A single place can appear more than once across categories if it genuinely spans them — don't force an artificial single bucket if a place is genuinely both. Every point where `recommended: true` gets a ⭐ **מומלץ** marker at the start of its bullet in Step 4 — only from Gemini's own flag, don't add or remove stars based on your own judgment of what seems notable.

### Step 4 — Write the master plan file

Save as `<Destination>_Master_Plan.md` in the destination folder:

```markdown
# Trip Master Plan: <Destination>
*Built <date> from <N> sources*

## Table of Contents
(list of regions, for navigation — this file will be long)

## <Region Name>

### טבע (Nature)
- **Place name** — one to two sentence description. (מקור: source name)
- ⭐ **מומלץ: Place name — granular activity** — one to two sentence description of specifically what this activity is and why the source called it out. (מקור: source name)
- ...

### אורבני (Urban)
...
### אטרקציות (Attractions)
...
### אחר (Other)
...

## <Next Region Name>
...
```

Attribute each place to its source (short form is fine, e.g. "(מקור: Wander-Lush)"; for a deduped place with multiple sources, list them all). **Use each point's `description_long` field here, not `description`** — the short one is a ≤20-word map-bubble fragment meant for Part B's `Route_Map.html`, and pasting it into the Master Plan would read as far thinner than the source material actually supports. If a place's `description_long` is itself short because that's genuinely all the source said, that's fine and expected — don't pad it.

## Part B — Build the interactive selection map

This half turns Part A's inventory directly into a map — no separate skill invocation, no waiting for confirmation, just continue straight on using the Master_Plan.md you just wrote.

### Step 5 — Reclassify places into the six marker categories

Same six categories every time, since the artifact's legend and icon set are built around exactly these: **Nature**, **City**, **Beach**, **Attraction**, **Food**, **Sleep**. Re-sort Part A's places into these (the Master Plan doesn't have a "Beach" or "Sleep" category — pull beach-specific places out of Nature/Attractions, and identify Sleep candidates yourself: towns/cities with enough concentration of nearby points, or places explicitly suited to overnighting — fewest sleep locations that still keep every other point reasonably reachable).

Drop anything too vague to be a real mappable point — but otherwise include **every concrete named place from Part A**, not a curated subset. Don't pre-filter by trip length, feasibility, or driving distance — the whole point of the checklist is that the user does that curation themselves, visually.

Carry forward each place's source attribution and its full Part A description (not a truncated one-liner — the info window is where that detail should surface), and carry the ⭐ מומלץ flag forward if present.

### Step 6 — Build the HTML map artifact

Produce **one single self-contained HTML file**, `<Destination>_Route_Map.html`, saved in the destination folder — inline CSS and JS, no build step, no external dependencies besides the Google Maps script tag. This skill uses Google Maps specifically (Maps JavaScript API + Directions API + Geocoding API) via an API key the user provides — not TomTom, not Canva, not an illustrated map. If a Google Maps API key isn't available this session, ask for one before building anything (or reuse a key already embedded in an existing `*_Route_Map.html` file elsewhere in this same project, if the user confirms that's fine).

**A note on the key:** it will be embedded in plain text in the generated HTML file — that's how the Google Maps JavaScript API works client-side, there's no way around it for a static page. Tell the user this plainly and suggest they restrict the key (HTTP referrer restriction) in Google Cloud Console. Never write the key into a memory file or reuse it across unrelated projects without the user's knowledge.

**Layout:** a map taking most of the viewport on one side, a scrollable checklist panel on the other, grouped by region. Within each region, order points recommended-first (⭐), then by category in the same order as the legend. Each region header gets its own select-all checkbox plus, once geocoding finishes, the driving time from the main airport/reference city shown on its own line under the header. Each point row shows a category-colored dot, a checkbox, and the name. A legend shows the six category colors. A "confirm selection" button sits prominently at the bottom of the checklist.

**Category filter.** Above the legend, add a row of filter buttons — one per category (Nature/City/Beach/Attraction/Food/Sleep) plus a `הצג הכל` (show all) button, active by default. Clicking a category button shows only that category's markers on the map and hides the other categories' rows in the checklist — a pure *view* filter for browsing, completely separate from each point's checkbox/selection state (never uncheck anything just because it's filtered out of view). Clicking `הצג הכל` restores every marker and every row. Keep the active filter visually distinct (e.g. a pressed/highlighted state).

**Auto-suggest a starting selection.** Add a `הצע בחירה מתאימה לטיול` button near the confirm button, wired to a `suggestSelection()` function. Before building the page, read `<Destination>_Trip_Input.md` and embed three constants near `DESTINATION_NAME`: `const TRIP_DAYS = <integer from Trip Input's "כמה ימים" field>;`, `const TRIP_PACE = '<a short read of the emphases field, e.g. "רגוע", "עמוס", "משפחתי">';`, and `const INTEREST_CATEGORIES = [<the map categories that match the emphases field's stated interests, e.g. ['Nature','Food'] for "אוהבים טבע ואוכל מקומי">];` — compute these once at generation time, don't parse dates or free text in the page's own JS. **Read the explicit "כמה ימים" field directly** — Trip Input carries days and nights as two separate numbers precisely so this doesn't have to be inferred from a date range or a "when" free-text field. Only fall back to counting inclusive days from a date range if "כמה ימים" is genuinely blank on an older Trip_Input.md that predates that field.

Clicking the button runs a pure client-side heuristic (no network calls) that builds `TRIP_DAYS` day-shaped geographic clusters (never a flat, ungrouped pick across the whole map) and stops there — it never auto-confirms, the user still reviews and adjusts before clicking confirm. The suggestion must visibly reflect **what the sources say is unmissable** and **what this user said they care about** — a pick that ignores either is a bad pick:
1. **Points per day** from `TRIP_PACE`: 3 if it reads relaxed/family-oriented (רגוע/משפחתי/קל), 5 if it reads packed/ambitious (עמוס/אינטנסיבי/הרבה), otherwise 4. Total target = `TRIP_DAYS × pointsPerDay` — for a 2-day trip at the default pace that's 8 points, not 2-3. This is a floor to fill toward, not a ceiling to undershoot.
2. **⭐ recommended points are the backbone**: seed each day's cluster from an unused ⭐ point, picking seeds from *different* regions/areas so days don't pile into one corner. Within the regions the clusters end up using, **every ⭐ point should make the selection** unless the day quotas genuinely can't hold them — these are the "אסור להפסיד" places, and dropping one silently is the worst failure mode of this feature.
3. **Fill remaining slots interest-first**: prefer unused points whose category is in `INTEREST_CATEGORIES`, then points whose description marks a unique local experience (rafting, a named festival, a one-of-a-kind attraction — Round 2/3 material), then everything else — always nearest-first within the day's region, mixing categories enough that no day is one-note. If a region runs out of points for a day's quota, pull from an adjacent region rather than shipping a thin day.
4. Separately auto-check one sensible Sleep-tagged point per region actually used across the clusters — a base needs somewhere to sleep even though the lodging point itself isn't a "visit," and it doesn't count against the per-day point target.
5. Check the corresponding checkboxes (reusing the existing checkbox-to-marker wiring so markers update live) and show a status line: per-cluster point counts ("Day 1: 4 points..."), regions used, how many ⭐ points were included out of how many available in those regions, and an explicit note that this is a starting suggestion to review before confirming — not a final answer or an actual day assignment (that happens later, in final-trip-planner).

**Right-to-left content:** if place names/descriptions are in Hebrew (or another RTL language), the checklist and info windows must render right-aligned with RTL text flow (`dir="rtl"`, `text-align: right`). Three traps, all discovered the hard way:
- Don't embed a neutral glyph (like ⭐) directly inside a mixed Hebrew/Latin text string — bidi reordering can place it wrong. Give badges/icons their own sibling elements next to the name, not spliced into the name string.
- Google's localized `duration.text`/`distance.text` can come back as a mix of Hebrew and English (e.g. "3 שעות 5 mins") even with `&language=he` loaded. Compute your own fully-Hebrew string from the numeric `duration.value`/`distance.value` instead.
- **Never put `dir="rtl"` on the `<html>` (or `<body>`) tag of this map+sidebar page.** `#app` is a plain `display: flex` container with `#map` as its first DOM child and `#sidebar` as its second — flexbox resolves the main axis using the inline/writing direction, so a page-level `dir="rtl"` silently flips that order, putting the sidebar on the left and the map on the right (the opposite of the intended, established layout). Scope RTL to the sidebar only: `<html lang="he">` with no `dir` attribute, and `direction: rtl; text-align: right;` set on `#sidebar` in the CSS. This bug is easy to introduce by copying a generic RTL-page boilerplate that puts `dir="rtl"` on `<html>` — don't do that here even though it's the right call on single-column pages like the Showcase or the trip-input form.

**Geocoding:** use the client-side `google.maps.Geocoder` to resolve each place's coordinates from its name plus destination/region for disambiguation, and pass `componentRestrictions: { country: <ISO code> }` on every call — without it, a query like "Racha region, Georgia" can silently resolve to the wrong country, since a status of "OK" doesn't mean "found the right country." Avoid queries that describe an *activity* rather than a *place* ("Martvili Canyon boat tour" instead of "Martvili Canyon") — keep activity detail in the description text, not the geocoder query.

**Naming contract (required, exact):** the generated page must define these exact identifiers, because an automated verifier (`tools/verify_route_map.js`, run in Step 6b) checks for them by name: `DESTINATION_NAME`, `LOCAL_SERVER_URL`, `TRIP_DAYS`, `TRIP_PACE`, `SLEEP_MARKER_SCALE`, and functions `applyCategoryFilter(...)`, `suggestSelection()`, `focusMapPoint(id)`, `highlightRegion(...)`, `sendSelectionToLocalServer(...)`. Don't rename or inline them away.

**Behavior:**
- Add a `google.maps.Marker` for every point, using a distinct icon color per category (six clearly distinguishable colors, consistent every time — e.g. green/nature, purple/city, blue/beach, orange/attraction, red/food, black-or-navy/sleep). Give recommended (⭐) points a visually distinct treatment too (e.g. gold stroke ring).
- **Sleep points render noticeably larger than everything else** — define `const SLEEP_MARKER_SCALE` at roughly 1.6-1.8x the default marker scale and use it for every Sleep-category marker. "Where can I sleep around here" is the anchoring question while curating a map, and lodging anchors must be findable at a glance at any zoom, not hunted for among 70 same-sized dots.
- Wire every checkbox to its marker's visibility (`marker.setMap(checked ? map : null)`) — live and instant, no reload.
- Flag sleep-candidate points visually in the checklist (e.g. a bed icon/label).
- **Every marker needs a click-to-open info window** with the place's full description and a clickable source link.
- **Only one info window open at a time** — a single shared `google.maps.InfoWindow` instance, `.setContent()` then `.open()` at the new marker.
- **Never pass `label: null` to a Marker** — the constructor throws if `label` is explicitly `null` (vs. just omitted), silently aborting that marker's whole setup callback including its info window and click listener. Only set `label` when there's an actual label to show. Wrap marker/info-window setup in try/catch and log failures.
- **Clicking a checklist row grows that marker on the map, pans to it, AND opens its info bubble** — the same three things that happen when the marker itself is clicked directly, not just a subset. (Store the info window's HTML content on the point object itself, e.g. `p.infoContent`, rather than only inside the marker's own click-listener closure — that's what lets the checklist-row handler open the identical bubble.) Animate the icon scale up on focus, then back down when a different point is focused next.
- **Clicking a region's label highlights that region's area as a CIRCLE — never a polygon.** Implement as a `highlightRegion(...)` function that does exactly this, in this order:
  1. Reject outliers: compute each region point's distance from the region's median point, and drop any point past ~2.5x the region's median spread — an outlier that far out is almost always a bad geocode, not a genuinely huge region. (The dropped point keeps its own marker and checklist row; only the highlight ignores it.)
  2. Draw one `google.maps.Circle` centered on the surviving points' median, with radius = the maximum distance from that center to a surviving point, times ~1.15, floored at ~3km — a clean, immediately-readable "the region is around here" shape. **Convex-hull polygons over geocoded points were tried and rejected in real use**: with imperfect geocoding they render as weird spiky connect-the-dots shapes that read as errors, and with an outlier they balloon into country-sized nonsense. A circle is honest about its own imprecision. Do not draw `google.maps.Polygon` region overlays at all.
  3. **`map.fitBounds()` to the circle's own bounds, padded to ~4x its radius (minimum 15km) — never to the whole country.** A real run did exactly that (fit to *every* geocoded point first, "so the highlight is seen in whole-country context") and it broke on a small, dense region: Tbilisi's cluster (21 points within ~3km of each other) drew a floor-radius circle that was confirmed correctly created (center, radius, `getVisible()` all checked out via JS) but was *smaller than the marker icons sitting on top of it* at a zoom level spanning the entire country — completely invisible in practice despite being technically present. Padding around the circle's own size, not the country's, keeps some surrounding geography visible for orientation while guaranteeing the region itself is actually visible whether it's a single small city or a sprawling multi-city region. Build the padded bounds via `google.maps.geometry.spherical.computeOffset(center, paddingRadius, bearing)` at 0/90/180/270°, extending a `LatLngBounds` with each — don't try to hand-roll a lat/lng degree offset, it distorts at latitude extremes.
- **Geocoding accuracy matters more than it looks like it would** — a query that's too abstract (a trail name, an obscure sub-attraction with no strong anchor) can silently resolve to a generic fallback location (often near the country's capital/centroid) instead of the real place, and a status of "OK" won't reveal this. Anchor every query to a real, findable settlement or landmark name (not a route/trail/festival name alone), and if a region's circle ever looks implausibly large despite the outlier filter, treat that as a signal to re-check that region's geocode queries rather than a map bug.
- **Confirming locks in the selection — it does not build a route.** Hide the checklist/legend, show a plain grouped list of the checked points (by region), with a note that this list is the input for a future route-building skill. Don't call `DirectionsService` for route purposes here, don't sequence sleep bases, don't draw route polylines. Give the user a way to go back and adjust the checklist.
- If Directions API calls (for the per-region distance-from-reference-point display) fail, surface a plain-language fallback (e.g. "travel time unavailable") rather than leaving it blank, and stagger the requests (don't fire one per region simultaneously) to avoid silent rate-limit failures.
- **Also send the confirmed selection to the local helper server, as a standard part of every build (not a one-off patch).** Near the top of the `<script>` block, define `const DESTINATION_NAME = '<Destination>';` and `const LOCAL_SERVER_URL = 'http://localhost:8787/confirm-selection';`. At the end of the confirm handler (after locking in the on-screen summary), call a `sendSelectionToLocalServer(checked)` function that POSTs `{ destination: DESTINATION_NAME, points: checked.map(p => ({ id, name: p.name, category: p.category, region: p.regionName, rec: !!p.rec, isSleep: !!p.isSleep })) }` as JSON to `LOCAL_SERVER_URL`, then updates the status line with a plain-language result: success (`✅ ... נשלחה ונשמרה אוטומטית ... אפשר לחזור לצ'אט ולומר "תמשיך"`), a server-side error (`⚠️ השרת המקומי הגיב עם שגיאה: ...`), or — in the `.catch()`, since `fetch` throws when nothing is listening on `localhost:8787` — a connection-failure message telling the user to make sure `start_local_server.bat` is running (`⚠️ לא הצלחתי להתחבר לשרת המקומי...`). This is purely additive: the on-screen locked list and the old "describe your selection in chat" fallback keep working exactly as before whether or not the local server happens to be running, so this never becomes a hard dependency.
- **The confirm control must give immediate feedback and guard against double-submission — same requirement as trip-scan's Tab 2 confirm button, and for the same real reason: a user unsure a click registered will click again, and `local_server.js` always writes a fresh `confirmedAt`, so a second click looks like a genuinely newer confirmation and queues a second, fully duplicate downstream run.** Disable the confirm control the instant it's activated, show a `⏳ שולח...`-style status line before `sendSelectionToLocalServer`'s `fetch` even starts (plus an in-flight boolean guard), and only re-enable it in the `.catch()` branch so a real connection failure can be retried — a success should leave it disabled, since re-confirming the same locked-in selection isn't a real use case. If the status line has a `pending` state, give it its own CSS rule with `display: block` — a base `.status`/`.result-message`-style rule that defaults to `display: none` will otherwise swallow it silently.

### Step 6b — Run the automated map verifier (required)

Run `node tools/verify_route_map.js "<Destination>/<Destination>_Route_Map.html"` from the Trip Planner root. It statically checks the generated file for every contract item above (naming contract, circle-not-polygon region highlight, single shared InfoWindow, sleep marker scaling, category filter, suggest button, local-server wiring, RTL traps, geocoding country restriction). **Fix every FAIL it reports and re-run until it passes clean** — do not proceed to Step 7 with failures. If the verifier itself is missing or errors out, say so explicitly in your final output rather than skipping the check silently.

### Step 7 — Update the dashboard and continue the pipeline

Update Tab 4's block in `<Destination>_KESSLER_TRIP.html` (between the `<!-- TAB4:START -->` / `<!-- TAB4:END -->` markers, leave everything else untouched) with:
```html
<iframe class="embed" src="<Destination>_Route_Map.html"></iframe>
```

Then, without waiting for confirmation, continue straight into [[destination-showcase]] using the Master_Plan.md from Part A — it only needs that file, not the map or any selection. Only stop and report back to the user once destination-showcase has also finished, so they see Tab 3 and Tab 4 populated together. Picking which points to keep on the map is their call, made back in chat once they've had a look — not something to prompt for mid-skill.

## Notes

- This will naturally be a long Master Plan document — that's expected. A table of contents and clear region/category headers keep it navigable.
- If two sources recommend the same place, mention it once but attribute both.
- No itinerary framing in the Master Plan (no "Day 1," no trip-length assumptions, no "best for families" filtering) — keep Part A purely an inventory.
- If a source turns out to have very little actual place content despite passing trip-scan's relevance check, note that briefly rather than padding the list.
- No TomTom, no Canva, no illustrated map for Part B — Google Maps via the user's own API key is the point.
- Keep the checklist and the map genuinely in sync at every step in Part B — the whole value of this artifact is that curation happens visually.
- Resist the temptation to fold actual route-building (sleep-base sequencing, driving times between legs, day-by-day shape) into this skill even though it might seem convenient — that boundary is deliberate, so a later route-building skill has a clean, well-defined input (the confirmed selection) to work from.
