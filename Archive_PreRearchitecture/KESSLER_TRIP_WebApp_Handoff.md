# KESSLER_TRIP → Web App: Handoff Brief for Claude Code

## Why this document exists

KESSLER_TRIP currently runs as a Claude Cowork pipeline: five skills, each writing static self-contained HTML files into a per-destination folder (`<Destination>_KESSLER_TRIP.html` plus a handful of sibling files), with Google Maps embedded client-side. It works, but it has three structural limits that are inherent to "static files opened in a browser":

1. **No callback.** The interactive selection map's "confirm" button can't report the chosen points back to Claude — the only way that data has moved forward so far is the user taking a screenshot or typing the selection into chat.
2. **No persistence beyond the file itself.** Checklist checkbox state lives in that browser's `localStorage`; there's no shared "the trip" that multiple people or devices can see and update.
3. **Not reachable from anywhere.** The dashboard is a local file path, not a URL — nobody but the person with that folder can open it.

Nir wants to turn this into a real web application: reachable from any device, with an actual trip-planning form and a selection UI that, on confirm, updates the whole trip automatically — no screenshots, no "tell Claude in chat it's done."

**Decisions already made (via a scoping conversation), binding for this build:**
- **Access:** No accounts, no passwords. Shareable link, open to whoever has it (family/friends). Keep this simple — don't build an auth system.
- **AI integration:** The app calls the **Anthropic (Claude) API directly** from its own backend, using a key Nir provides. The "creative" pipeline steps (source curation, place research, day sequencing, restaurant picks, fun day blurbs, advance-booking checks) become server-side API calls the app makes itself — not something that happens in a Claude chat conversation.
- **Stack/hosting:** Nir already has an app called **KESSTIME** on GitHub and wants this built with the same tools. **Before writing any code, open that existing repo and mirror its framework, hosting target, database/ORM choice, and deployment pattern exactly** — don't introduce a new stack. This document deliberately doesn't prescribe a framework for that reason.

## What this document is (and isn't)

This is a **behavioral and data spec**, not a build plan with code. It exists so a fresh Claude Code session has full context on what the current system already does well (and where it broke, and why) without needing to reverse-engineer five HTML files and five SKILL.md files from scratch. Claude Code should treat the existing Slovenia build as the reference implementation for *behavior*, and the KESSTIME repo as the reference for *stack*.

Reference files (read these directly, they're the real spec):
- `Trip Planner/Slovenia/Slovenia_Trip_Input.md`
- `Trip Planner/Slovenia/Slovenia_Sources.html`
- `Trip Planner/Slovenia/Slovenia_Master_Plan.md`
- `Trip Planner/Slovenia/Slovenia_Route_Map.html`
- `Trip Planner/Slovenia/Slovenia_Showcase.html`
- `Trip Planner/Slovenia/Slovenia_Final_Map.html`
- `Trip Planner/Slovenia/Slovenia_Final_Showcase.html`
- `Trip Planner/Slovenia/Slovenia_Checklist.html`
- `Trip Planner/Slovenia/Slovenia_KESSLER_TRIP.html` (the shell that ties the above together as 7 tabs)
- The five `SKILL.md` files (`new-trip-input`, `trip-scan`, `trip-master-plan`, `destination-showcase`, `final-trip-planner`) — these encode every rule, lesson, and hard-won bug fix from building this the first time.

## The pipeline, reframed as an app

| Stage | Today (Cowork skill) | As a web app |
|---|---|---|
| 1. Trip input | Chat, one question at a time | A real form: destination, dates, participants, composition (kids/adults + ages), car y/n, trip emphases |
| 2. Source curation | Claude checks a standing "Knowledge Hubs" index + finds new sources | Backend calls Claude API to do the same search/curation, stores results |
| 3. Master plan + selection map | Claude mines sources into a categorized place list, builds a static Google Maps HTML picker | Backend calls Claude API to build the place list (stored in DB); frontend renders the same kind of interactive map, but "Confirm" POSTs to the backend instead of just changing local page state |
| 4. Destination showcase | Claude picks ~10-14 highlight places + writes hero copy | Backend calls Claude API for the same; stored + rendered from DB |
| 5. Final trip plan | Claude sequences days/bases, writes schedules, blurbs, restaurants, checklist — **currently blocked waiting for the user to report the confirmed selection back in chat** | **This is the actual unblock.** Confirm button → API call with the selected point IDs → backend runs the same sequencing/scheduling logic (partly deterministic code, partly a Claude API call for the generative bits) → writes the final day plan, showcase, and checklist straight to the DB → dashboard updates live. No chat round-trip. |

## Data model (derived directly from the current file formats)

This maps closely to what a database schema should look like. Field names below are taken verbatim from the real Slovenia build.

**Trip**
- id, destination (Hebrew name), date range, participant count, composition (kids/adults + ages), car (bool), emphases (free text)
- created_at, status (which pipeline stage has completed)

**Source** (one trip has many)
- title, url, kind (`base` = from the standing Knowledge Hubs index, `added` = found specifically for this destination)

**Place** (the full inventory — trip-master-plan's output, ~30 for Slovenia)
- id, region, category (`Nature` | `City` | `Beach` | `Attraction` | `Food` | `Sleep`), name, query (geocoding string), description, source attribution, url, `rec` (boolean, "⭐ recommended" flag), `is_sleep` (boolean)

**Selection** (which Place ids the user confirmed — this is what today's "confirm" button locks in, currently only ever communicated via chat)
- trip_id, place_id, selected_at

**Day** (final-trip-planner's output, one trip has many, ordered)
- day_number, label, date_label, base (the night's lodging place name), blurb (short fun intro line), wake, breakfast, travel_note
- points: ordered list of Place ids visited that day
- route: ordered list of `{label, query}` stops (base → stop → stop → base), used to fetch Directions
- restaurants: list of `{name, note}`

**ChecklistItem** (final-trip-planner's Tab 7 output — **this absolutely must move server-side**; it was `localStorage` only because there was no backend)
- trip_id, section (flights/car | lodging | advance-booking attractions | restaurants), name, note, date_from, date_to, done (boolean)

**ExtraPlace** (places that exist in the full inventory but weren't selected — today rendered as "worth knowing about" at the bottom of the final map, with driving distance computed live from whichever day's base is currently being viewed)
- same shape as Place, just `selection` has no matching row

## Behavior that must carry over — hard-won lessons, not optional polish

These were each a real bug found and fixed during development. Reproducing the static-file version's design without also reproducing these fixes will reintroduce the same bugs:

- **Google Maps script loads async.** Any code that does `class X extends google.maps.OverlayView` (or extends any other `google.maps.*` type) must not run until the Maps script has actually finished loading — never as a top-level statement that executes at parse time. In a proper web app with a build step this is much easier to get right (import the Maps loader library, await it before touching `google.maps`), but call it out explicitly so it isn't silently reintroduced.
- **`componentRestrictions: { country: <ISO code> }` on every Geocoder call.** Without it, a short/ambiguous query can silently resolve to the wrong country — a status of `"OK"` does not mean "found the right place."
- **Never pass `label: null` to a `google.maps.Marker`.** The constructor throws on an explicit `null` (vs. omitted), silently aborting that marker's entire setup.
- **One shared `InfoWindow` instance**, not one per marker.
- **Stagger Geocoding/Directions/DistanceMatrix-equivalent calls** — firing many at once risks silent rate-limit failures. (In practice, prefer `DirectionsService` over `DistanceMatrixService` for anything cross-network — Distance Matrix is a separate Google API that may not be enabled even when Directions/Geocoding work fine, and it fails as an all-or-nothing wholesale error rather than degrading gracefully.)
- **Compute Hebrew duration/distance strings from the raw numeric `.value`, never from Google's localized `.text`** — it can come back mixed-language (e.g. "3 שעות 5 mins") even with `language=he` set.
- **RTL handling:** don't splice a neutral glyph (like ⭐) directly into a mixed Hebrew/Latin string — bidi reordering can misplace it. Give badges their own sibling element.
- **Region-highlight / convex-hull overlays must never change map zoom/pan** — only draw the overlay. Auto-zooming on every click was tried and explicitly rejected (it fights the user and prevents comparing regions against each other).
- **Geocoding-accuracy risk near a country's centroid:** a query too abstract to anchor well (a trail name, an obscure sub-attraction) can silently resolve to a generic fallback location near the capital, even with status `"OK"`. Anchor every query to a real, findable settlement name.
- **Click-to-focus must always do all three things together:** grow the marker, pan to it, and open its info bubble — not a subset. This was broken twice (once on the selection map, once on the final map) by only wiring up a subset of the three.
- **Day-plan schedule times are rounded to the nearest half hour**, not shown to the minute — deliberately approximate, not a promise.
- **Sleep-base selection isn't limited to already-selected points.** If a cluster of kept points has no city/sleep-tagged point nearby, propose a real, findable town near that cluster as its own base — but stay within the destination's own country; a cross-border base is a bigger decision that needs explicit user go-ahead.
- **"Worth knowing about" distances are relative to whichever day is currently being viewed** (that day's own lodging base), not some fixed "nearest of all bases" figure.

## Suggested phased build order

1. **Data layer + trip form.** Stand up the DB (matching KESSTIME's existing choice), the Trip/Place/Selection/Day/ChecklistItem tables, and a real "new trip" form that replaces new-trip-input's chat questions.
2. **Selection map with a real Confirm endpoint.** This is the actual unblock Nir asked for — port `Slovenia_Route_Map.html`'s map/checklist behavior to the frontend framework, but make "Confirm" a real API call that writes to the `Selection` table and kicks off stage 5 server-side, instead of just changing local page state.
3. **Server-side pipeline via the Claude API.** Port trip-scan, trip-master-plan (Part A), destination-showcase, and final-trip-planner's generative steps into backend functions/routes that call the Anthropic API and write results to the DB, replacing the equivalent SKILL.md logic.
4. **Dashboard.** Port the 7-tab shell, driven by DB reads instead of static file embeds — this is where the pie charts, spaced schedule, on-map distance pills, and "worth knowing about" section all get re-rendered from real data.
5. **Checklist with real persistence**, replacing `localStorage` — this is what lets multiple people (family/friends with the link) see and check off the same list.

## Open items for Nir + Claude Code to settle together at kickoff

- Exact framework/hosting to mirror from KESSTIME (React/Next.js? Something else? Vercel, or a different host?).
- Where the Anthropic API key and the Google Maps key live (environment variables / hosting provider's secret store — never committed to the repo).
- Whether a trip needs to be explicitly "published" before its link is shareable, or every created trip is reachable by anyone with the link immediately.
- Multi-trip support: a list/home page of all trips, or one trip at a time.
