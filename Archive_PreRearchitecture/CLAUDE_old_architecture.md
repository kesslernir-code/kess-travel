# CLAUDE.md

Guidance for working in this repo. See [Skills_Reference/README.md](Skills_Reference/README.md) for a file-by-file index.

## What this is

KESSLER_TRIP: a 5-stage AI trip-planning pipeline (research → master plan + selection map → showcase → final itinerary), triggered from a local form and run **headless** — no chat message required. A background watcher (`trip_watcher.js`) detects new form submissions and confirmed map selections, and runs each pipeline stage by invoking `claude -p` itself.

There are no standing family/preference defaults anywhere in this repo, on purpose — every trip's parameters (destination, dates, days/nights, participants, car, emphases) come fresh from `New_Trip_Form.html` / `new-trip-input_SKILL.md`, every time.

## Architecture

- **5 skills** in `Skills_Reference/*_SKILL.md` (plain markdown instructions, not installed Claude Code Skills — a headless run is just told "read this file and follow it"): `new-trip-input` → `trip-scan` → `trip-master-plan` (Part A mining + Part B map) → `destination-showcase` → `final-trip-planner`. Each writes to a `<Destination>/` folder and updates one tab of that destination's `<Destination>_KESSLER_TRIP.html` dashboard (7 tabs, `kessler_trip_shell_template.html`).
- **`local_server.js`** — the only thing a human touches directly. `POST /new-trip` writes `Trip_Input.md` and immediately opens a `_KESSLER_TRIP_LOADING.html` placeholder (instant feedback — the real dashboard isn't built yet). `POST /confirm-selection` (called from a destination's `Route_Map.html`) writes `Selection.json`. Also auto-opens any genuinely new `*_KESSLER_TRIP.html` the moment it appears on disk.
- **`trip_watcher.js`** — watches the folder tree (native `fs.watch` + a 15s poll fallback, since Windows' recursive watch is documented as flaky) and runs the pipeline as a **sequence of separate `claude -p` sessions**, not one combined session:
  - Stage A (new trip): `stepA1-input-scan` (new-trip-input + trip-scan, **Haiku** — mechanical) → `stepA2-master-plan` (trip-master-plan Part A+B, **default model** — needs real judgment) → `stepA3-showcase` (destination-showcase, default model). Stops the chain on the first sub-step failure.
  - Stage B (confirmed selection): `final-trip-planner`, one session, default model.
  - **Why split sessions**: one long combined session means every later turn re-reads the whole accumulated context from cache — that compounding cache-read was the single biggest cost driver in real measurements. Splitting resets context between skills; each skill already reads its inputs from disk anyway, so nothing is lost.
- **Auth**: `.env.local` (git-ignored, never commit) holds either `CLAUDE_CODE_OAUTH_TOKEN` (subscription — shares a session-limit pool with all other Claude Code use on this machine, including interactive chat) or `ANTHROPIC_API_KEY` (dedicated key — pay-per-token, independent limit). Only one should be active (comment out the other) to avoid ambiguity. **Do not reuse kessler-time's API key** — that account has its own low monthly spend cap tuned for a cheap scraper, and Trip Planner's research workload will exhaust it in one afternoon (this happened once already).
- **Desktop launcher**: `setup_desktop_shortcut.ps1` (one-time, real terminal) → `KESSLER_TRIP.lnk` → `start_kessler_trip.vbs` → `launch_kessler_trip.js` (ensures `local_server.js` + `trip_watcher.js` are running, opens the form).

## Critical invariant — mining must be real

**`trip-master-plan_SKILL.md` Part A must issue real `WebFetch`/`WebSearch` calls against actual source pages.** This is not a theoretical risk — a real run produced a complete-looking, well-organized Master Plan with **zero** web calls, entirely from the model's general knowledge, silently discarding the point of `trip-scan`'s curated source list. Verify this whenever the skill or the pipeline changes: check the session transcript (`~/.claude/projects/<project>/*.jsonl` and its `subagents/` subfolder) for `WebFetch`/`WebSearch` tool calls. A correctly-working run spawns several parallel research subagents and racks up 80-100+ real web calls; a fabricated run has none. The skill file now has an explicit, forceful check for this — don't weaken that language.

## Known real costs (measured, Sonnet 5 intro pricing, per destination)

| Step | Model | Real work | Cost |
|---|---|---|---|
| stepA1 (input+scan) | Haiku 4.5 | ~1 subagent, ~28 web calls | ~$0.40 |
| stepA2 (master-plan) | default | 5 parallel subagents, ~100 web calls | **~$7.70** (budget cap: $22) |
| stepA3 (showcase) | default | image search via WebFetch | ~$2 |
| stageB (final-planner) | default | day sequencing + restaurant/booking search | not yet measured with current architecture |

Total Stage A for a real run: roughly $10-12. These numbers will vary a lot with destination size (more regions/sources = more subagents = more cost) — don't assume they're a hard ceiling.

## Known open items (not yet verified)

- **Stage B has not been tested end-to-end with the current split-session architecture** — only tested under the old combined-session design. Verify cost/timing/correctness the same way as Stage A once a selection is confirmed.
- `new-trip-input_SKILL.md`'s instruction to delete `_KESSLER_TRIP_LOADING.html` once the real dashboard exists has not been confirmed to actually fire in a real run — check for leftover `_LOADING.html` files.
- A real run once produced garbled text (stray Cyrillic/Japanese characters mixed into Hebrew content) mid-generation in `trip-master-plan`'s output; the agent caught and cleaned it before finishing that time, but the root cause is unknown and unconfirmed as fixed. Worth checking for on future runs.
- The map's region-highlight fixes (whole-map `fitBounds` on click, outlier-rejection in the convex hull) and the Tab-4 category filter / "suggest a plan" button are all recent and have only been verified on one destination (Georgia) — worth confirming on a second, differently-shaped destination (e.g. a dense single-city trip vs. a multi-region one).
- `final-trip-planner_SKILL.md`'s per-leg Directions fetching fix (each consecutive pair fetched separately instead of one multi-waypoint request that fails as a whole on one bad leg) is written but not yet exercised by a real run.

## Environment gotchas (this machine)

- `node` is at `C:\Program Files\nodejs\node.exe` — not reliably on PATH for non-interactive tool contexts; the real claude CLI lives at `C:\Users\user\AppData\Roaming\npm\claude.cmd` (installed via `npm install -g @anthropic-ai/claude-code`) — always call it by full path from scripts.
- Windows caches shortcut icon bitmaps by file path — overwriting an `.ico`'s content under the same filename often doesn't visibly refresh until the icon cache is cleared and Explorer restarted (`setup_desktop_shortcut.ps1` does this automatically now).
- A subagent's own tool calls (e.g. the WebFetch calls done by trip-master-plan's mining subagents) live in a **separate** transcript file under `<session-id>/subagents/*.jsonl`, not in the parent session's `.jsonl` — check both when auditing what a run actually did.
- `--output-format text` only writes output once the whole `claude -p` run finishes — an empty log file during a run is normal, not a hang. Check the live transcript's file size/mtime to confirm it's actually progressing.

## Testing a change

```
node trip_watcher.js                 # run the watcher directly, see live logs
```

To test one skill in isolation without going through the form/watcher, run `claude` headless directly with a prompt telling it to read one `Skills_Reference/*_SKILL.md` file and execute it for a specific destination — see `trip_watcher.js`'s `prompt*` functions for the exact phrasing pattern used in production.

To verify a run's actual behavior (not just its exit code): find its session transcript under `~/.claude/projects/<sanitized-project-path>/`, matched by mtime to the run's start/end time in `logs/trip_watcher.log`, and inspect its `tool_use` blocks (and its `subagents/` folder) directly rather than trusting the visible chat-style output alone.



Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

