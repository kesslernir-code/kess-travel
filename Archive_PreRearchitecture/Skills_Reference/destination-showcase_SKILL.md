---
name: destination-showcase
description: "Stage 4 of the KESSLER_TRIP pipeline. Builds a self-contained HTML 'landing page' for a destination from a trip-master-plan Master Plan: a Hebrew destination name with a hero photo, a short background section, and a curated grid of highlight cards (places the Master Plan flagged as recommended plus at least one highlight per region), each with a real photo and description. Auto-triggered by trip-master-plan right after it writes the Master Plan, populating Tab 3 of the destination's KESSLER_TRIP dashboard. Personal use only, so photo sourcing is fast and lightweight -- no license verification or attribution needed. An inspirational overview, not an itinerary, route, or full place inventory. Use whenever the user wants a 'destination showcase' / 'עמוד נחיתה' / visual overview page from an already-completed Master Plan."
---

# Destination Showcase

Stage 4 of the KESSLER_TRIP pipeline: [[new-trip-input]] (Tab 1) → [[trip-scan]] (Tab 2) → [[trip-master-plan]] (master list + selection map, map shown in Tab 4) → **this skill** (Tab 3) → [[final-trip-planner]] (Tab 5, Tab 6, Tab 7). Note the tab numbers don't match run order: this skill runs *after* trip-master-plan but shows up in the *earlier* Tab 3 slot — Tab 3 and Tab 4 were deliberately swapped so the dashboard reads inspiration-then-tool (Showcase before map). Normally runs automatically right after trip-master-plan finishes writing the Master Plan — no need to wait for the user to pick points on the Tab 4 map first, since this skill only reads the Master Plan, not the selection. Where trip-master-plan's map is a working tool for curating and mapping every place, this skill is a polished, inspirational overview meant to be looked at, not worked with. It does not filter by trip dates or family logistics, does not build a route, and does not try to include everything in the Master Plan — it picks a curated handful of standout content and presents it beautifully.

## Step 1 — Gather the input

Find `<Destination>_Master_Plan.md` in the project folder. If it doesn't exist, tell the user to run trip-master-plan first — this skill only curates from an existing Master Plan, it doesn't do its own place research.

## Step 2 — Select what to feature

Build a curated shortlist, not a full copy of the Master Plan:

1. Take every place the Master Plan flagged with ⭐ מומלץ.
2. For any region that still has zero places in that set, add its single strongest-sounding highlight (by the Master Plan's own description) so every region gets at least token representation — the point is a page that feels like it covers the whole destination, not just its two or three most-hyped regions.
3. Keep the total to a page that reads as curated, not overwhelming — roughly 8–14 featured places total is a reasonable range regardless of how large the Master Plan is. If step 1 and 2 together produce far more than that, trim by dropping the least distinctive additions from step 2 first (recommended places from step 1 stay).

Also pick one single hero image candidate from this shortlist — the most visually iconic place, the one that best represents the destination at a glance (a landmark, a dramatic landscape, something instantly recognizable) — to feature large at the top of the page.

## Step 3 — Source real photos

This tool is for Nir's personal use only, not for publication or redistribution — so photo sourcing should be quick and pragmatic, not a research project. No license verification, no per-image attribution tracking, no credits section. Just find a real, good-quality photo of the actual place.

For the hero image and every featured place, search for the place by name (Wikimedia Commons is a convenient default source, e.g. search `<place name> wikimedia commons`, since its files are reliably hotlinkable via `https://commons.wikimedia.org/wiki/Special:FilePath/<exact file name>` without needing to open the file's description page at all) and use whatever real photo actually shows the place well. Don't spend time trying to extract the photographer's name or license terms from Commons file pages — that lookup has proven slow and unreliable in practice, and isn't needed here.

If no decent photo turns up for a specific place after a real search, substitute a good photo of the broader area/region it's in, or drop that place from the featured set and promote the next-best candidate from Step 2 instead. Don't leave a card photo-less if a reasonable substitute exists.

## Step 4 — Write the background section

A short (2–4 paragraph) background section introducing the destination as a whole — landscape, culture, what makes it distinctive, why someone would want to visit — in Hebrew, in an engaging landing-page voice, but grounded in what the Master Plan and general knowledge of the destination actually support. Don't invent specifics (numbers, historical claims, superlatives) that aren't backed by something in the Master Plan or otherwise verifiable.

## Step 5 — Build the HTML page

Produce **one single self-contained HTML file** (`<Destination>_Showcase.html`) — inline CSS, no build step, no external dependencies besides the hotlinked image URLs themselves. Structure:

- **Hero section:** the destination's name in Hebrew, large, over or beside the hero photo; a one-line evocative tagline underneath.
- **Background section:** the Step 4 text, comfortably readable (constrained line width, generous line height).
- **Highlights grid:** a card per featured place — photo, name, a genuinely descriptive 2–4 sentence write-up (not a caption-length fragment), and a small category indicator. Group or order the cards in a way that reads naturally (e.g. by region, or hero-adjacent places first) rather than dumping them in Master Plan source order.

No photo-credits section — this is personal-use only, so skip attribution entirely.

**RTL:** the whole page is Hebrew-first — set `dir="rtl"` and right-aligned text throughout (this is a single-column page, not the map+sidebar flex layout, so a page-level `dir="rtl"` is correct here — unlike trip-master-plan's Route_Map.html, see that skill's notes). Following the same lessons already learned in trip-master-plan's map: don't splice neutral symbols into mixed-language text runs; give badges/icons their own elements.

**Visual tone:** this page's whole reason to exist is to look good and feel exciting — generous imagery, real whitespace, a considered type scale (the destination name and hero tagline should be dramatically larger than body text), and restraint in how much text sits next to each image. If in doubt, cut text rather than crowd the page.

## Step 6 — Save and update the dashboard

Save the HTML file (`<Destination>_Showcase.html`) in the destination folder. Then update Tab 3's block in `<Destination>_KESSLER_TRIP.html` (between the `<!-- TAB3:START -->` / `<!-- TAB3:END -->` markers, leave everything else untouched) with:
```html
<iframe class="embed" src="<Destination>_Showcase.html"></iframe>
```

If this run was triggered automatically as part of the pipeline (i.e. trip-master-plan just finished), this is also the point where the whole chain pauses — report back to the user that Tab 3 (showcase) and Tab 4 (map) are both ready, and that picking which points to keep is their call, made in chat once they've had a look. Don't prompt for that selection yourself; just hand it back.

## Notes

- This tool is for Nir's personal use only — no license verification, no attribution, no credits section. Don't let photo-sourcing turn into a research project; if a photo isn't found quickly, substitute or move on.
- This is not the place to relitigate trip logistics — no dates, no "how many days do you have," no driving times. That's trip-master-plan's map and any future route-building skill's job.
- If the Master Plan is thin on ⭐ recommended places (e.g. an early or shallow trip-master-plan run), it's fine to lean more heavily on Step 2's per-region fallback — just say so rather than presenting a sparse recommended set as if it were comprehensive.
