---
name: new-trip-input
description: "Kicks off the KESSLER_TRIP pipeline for a brand-new destination. Gathers the trip's basic parameters through conversation (destination, dates, participants, planning emphases, transportation), creates the destination's folder and a persistent tabbed dashboard file named after the destination (e.g. Georgia_KESSLER_TRIP.html), saves the input as Tab 1, and then immediately continues into trip-scan without waiting for further confirmation. This is the front door of the pipeline -- trip-scan, the merged trip-master-plan skill, and destination-showcase each fill in one more tab of the same dashboard as they finish. Use whenever the user wants to start planning a new trip / says something like 'רוצה לתכנן טיול ל...' / 'בוא נתכנן טיול חדש' / 'new trip to...'."
---

# New-Trip-Input

This is stage 1 of the KESSLER_TRIP pipeline: New-Trip-Input (Tab 1) → [[trip-scan]] (Tab 2) → [[destination-showcase]] (Tab 3) → the merged trip-master-plan+route-planner skill (Tab 4) → [[final-trip-planner]] (Tab 5, Tab 6, Tab 7). Note the tab order doesn't match run order: trip-master-plan actually runs and writes its map before destination-showcase does, but Tab 3/Tab 4 were deliberately swapped from the original build order so the inspirational overview (Showcase) reads before the working curation tool (map) in the tab strip. Each stage runs automatically as soon as the previous one finishes — no approval checkpoints between stages — except where a stage genuinely needs the user's judgment (e.g. picking which points make the route in Tab 4), which always happens back in chat, never inside the dashboard file itself.

**Why chat, not a literal HTML form:** a form that lives in a Cowork artifact can't write files or trigger further skill runs — there's no bridge from a button click back into an active Claude turn. So the "form" is just this conversation: ask the questions in chat, collect the answers, then act on them directly.

## Step 1 — Gather the trip parameters

There are no standing defaults to fall back on — `CLAUDE.md` deliberately holds no fixed family/preference profile. Every trip is defined from scratch, every time.

**Check for a locally-filled form first.** Nir can optionally fill out `New_Trip_Form.html` (a standalone page in the Trip Planner root) instead of answering in chat — submitting it, via the local helper server (`local_server.js`, started through `start_local_server.bat`), writes `<Destination>/<Destination>_Trip_Input.md` directly to disk. Before asking anything, check whether the destination named in the triggering message (or any recently-modified `*_Trip_Input.md` under the Trip Planner root, if no destination was named yet) already has this file. If it exists:
- Read it and treat its seven fields as already answered — don't re-ask anything it already covers.
- If any field is blank or missing, ask only for that specific field, one at a time, same as below.
- Confirm briefly what was picked up from the file before continuing, so the user knows it was read rather than ignored.

If no such file exists yet, fall back to chat entirely: the moment the user says something like "רוצה לתכנן טיול" / "בוא נתכנן טיול חדש" / "new trip to...", ask these seven **one at a time** — send a single question, wait for the user's reply, then send the next one — skipping only whatever the user already gave in their opening message. Don't bundle multiple questions into one message.

1. **לאיפה** — destination
2. **מתי** — when (dates if known, otherwise rough season/timing)
3. **כמה ימים / כמה לילות** — exact day and night counts, as two explicit numbers (not derived from the "when" answer) — this is what later stages (e.g. the Tab 4 map's suggested-selection heuristic) plan around directly, so get real numbers here rather than letting a stage downstream infer them from free text.
4. **כמה משתתפים** — how many participants
5. **כולל ילדים או מבוגרים** — composition: kids, adults, or a mix (and ages if relevant)
6. **עם רכב או בלי רכב** — with a rental car or without
7. **דגשים מיוחדים** — any special emphases for this trip (pace, interests, must-haves, things to avoid, budget, anything else)

## Step 2 — Create the destination folder and save the input

Create `<Destination>/` under the Trip Planner project root if it doesn't already exist — this is the single folder every KESSLER_TRIP file for this destination lives in from here on.

If `<Destination>_Trip_Input.md` doesn't already exist (i.e. the local form wasn't used), write it now: a short, clean record of everything gathered in Step 1. If it does already exist because the local form wrote it, and chat only filled in a couple of gaps, update that same file so it reflects the merged, complete answer set rather than leaving the gaps unfilled. Either way, this file is the source of truth other stages can read from if they need trip context (e.g. dates for seasonal advice, participant count for pacing).

## Step 3 — Build the dashboard shell

Copy `kessler_trip_shell_template.html` (in this skill's folder) to `<Destination>_KESSLER_TRIP.html` inside the destination folder. Fill in:

- `{{DESTINATION_HE}}` — the destination's Hebrew name
- `{{TAB1_CONTENT}}` — a `field-grid` of cards summarizing the Step 1 data (one card per field: destination, dates, participants, emphases, transportation)
- `{{TAB2_CONTENT}}` through `{{TAB7_CONTENT}}` — leave as the pending state: `<div class="pending"><div class="pending-icon">⏳</div><p>ממתין ל־[שם השלב]...</p></div>`

This file is a **standalone HTML file the user opens directly in a browser** — not a Cowork sidebar artifact. That's deliberate: Tab 4 (the interactive map) and Tab 3 (the showcase page, with hotlinked photos) both need real network access that the sandboxed artifact viewer doesn't allow. A plain browser tab has no such restriction.

If `<Destination>_KESSLER_TRIP_LOADING.html` exists in the destination folder (the local form's instant "still working on it" placeholder, opened the moment the form was submitted — see `local_server.js`), delete it once the real dashboard above is written — its job is done the moment there's a real dashboard to show instead.

**The tab-update contract:** every downstream stage that fills in a tab does it by replacing only the content between that tab's `<!-- TABn:START -->` / `<!-- TABn:END -->` comment markers in this same file — never rebuilding the whole shell from scratch, so the other tabs' content and the nav/CSS stay untouched. Tab 3 and Tab 4 get filled with a simple `<iframe class="embed" src="<Destination>_Showcase.html"></iframe>` / `src="<Destination>_Route_Map.html"` pointing at the actual generated file sitting right next to the shell in the same folder — the iframe just embeds the real, already-working page rather than trying to rebuild it inline. Tab 3 (Showcase) is filled by destination-showcase; Tab 4 (map) is filled by trip-master-plan — in that reading order the inspirational overview comes before the working curation tool, even though trip-master-plan technically runs and writes its map first.

## Step 4 — Continue immediately into Trip Scan

Don't stop and wait for confirmation here. Present the dashboard file to the user (so they have something to look at while the rest of the pipeline runs), briefly say what's happening next, and continue straight into [[trip-scan]] using the destination from Step 1. Trip-scan no longer needs to ask for the destination itself — it's already in `<Destination>_Trip_Input.md`.

## Notes

- The local form + helper server is an optional, purely local convenience layer — it never replaces the chat flow, only pre-fills it. If `local_server.js` isn't running or the user never opened the form, everything works exactly as before (ask the six questions one at a time).
- If the user gives incomplete info and it's genuinely blocking (no destination at all), ask before doing anything else — everything downstream depends on having a destination and folder.
- Keep each of Step 1's questions short and single-purpose — this should feel like a quick, natural back-and-forth, not an interrogation, even though it takes six separate exchanges instead of one bundled message (this is a deliberate choice, not an oversight — Nir prefers answering one at a time over a wall of questions).
- "Editing" Tab 1 later means the user tells you the change in chat — you update `<Destination>_Trip_Input.md` and re-fill Tab 1's block in the dashboard file to match. There's no in-browser editing.
