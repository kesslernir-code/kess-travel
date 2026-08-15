// Fetch a real image URL for a place, via Wikipedia's free API (no key). Used
// only for the ~12 showcase highlights, so the call count is bounded and small.
// The old pipeline hardcoded Wikimedia Commons Special:FilePath URLs guessed by
// filename -- fragile (many 404). This searches Wikipedia for the place and
// takes the top page's lead image, which resolves reliably for anything with an
// article and returns null (caller falls back to a gradient) for anything else.

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php';
const COMMONS_FILEPATH_BASE = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
const FETCH_TIMEOUT_MS = 10000;

// A real run saw all 12 highlight lookups fail in one pass, then the exact
// same queries succeed immediately on retry seconds later -- a transient
// Wikipedia API hiccup, not a real "no image exists" for landmarks like Bran
// Castle. Silently falling back to the guaranteed default image papers over
// that (no card is ever blank), but it means every card shows the same
// repeated photo instead of its own -- worth one quick retry before giving up.
const RETRY_DELAYS_MS = [500, 1500, 3000];

// Even with IMAGE_CONCURRENCY=1 (one request in flight at a time), firing the
// next request the INSTANT the previous one resolves is still a burst from
// Wikipedia's point of view if requests are landing every ~100-300ms -- a
// real full 109-place sequential run still saw 44/109 fall to the fallback
// image, including places (e.g. "Caru' cu Bere") confirmed to resolve fine
// standalone or in a small isolated batch. A fixed minimum gap between ANY
// two outgoing requests (regardless of how many are "in flight") is the
// actual guarantee sequential concurrency alone doesn't give.
const MIN_REQUEST_GAP_MS = 350;
let lastRequestAt = 0;
async function throttle() {
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
}

async function getJson(url) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    await throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'KesslerTrip/1.0 (trip planner)' } });
      clearTimeout(timer);
      if (res.ok) return await res.json();
    } catch {
      clearTimeout(timer);
    }
    if (attempt < RETRY_DELAYS_MS.length) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
  return null;
}

// A short/generic place name (a trendy restaurant called "Kané" or "Noua")
// can full-text-match a totally unrelated article -- a real query "Kané
// Romania" ranked "John R. Kane" (an unrelated American politician) as the
// TOP hit, ahead of anything actually about the restaurant, and the old code
// took whatever ranked first with a thumbnail, no relevance check at all.
// This isn't a perfect fix (short names can genuinely collide with unrelated
// titles that legitimately share the same word), but rejecting matches with
// ZERO word overlap with the place's own name catches the clear-cut cases
// (an unrelated politician, a random county) without needing real NLP.
function normalizeText(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
}
function isRelevantTitle(title, relevantTo) {
  const t = normalizeText(title);
  const words = normalizeText(relevantTo).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
  if (!words.length) return true; // nothing specific enough to judge by -- don't over-filter
  return words.some((w) => t.includes(w));
}

// Wikipedia article lead image (pageimages) for a search query. `relevantTo`
// -- when given -- should be just the place's own clean name (NOT query+
// destination): the destination word alone would trivially "match" almost
// any genuine Romania-related title, defeating the relevance check.
async function fromWikipedia(query, relevantTo) {
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrlimit: '3',
    prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '800',
    format: 'json', origin: '*'
  });
  const data = await getJson(`${WIKI_API}?${params}`);
  const pages = data && data.query && data.query.pages;
  if (!pages) return null;
  // generator=search returns pages with an `index`; pick the best-ranked one that has a thumb.
  const ordered = Object.values(pages).sort((a, b) => (a.index || 99) - (b.index || 99));
  for (const p of ordered) {
    if (p.thumbnail && p.thumbnail.source && isRelevantTitle(p.title, relevantTo || query)) return p.thumbnail.source;
  }
  return null;
}

// Wikimedia Commons file search -- catches places with a photo on Commons but
// no English Wikipedia lead image. Deliberately NOT relevance-filtered like
// fromWikipedia: Commons file titles are routinely transliterated/local-
// language descriptions of the real subject (a real correct match for "CEC
// Bank Palace" was filed as "Palacio CEC, Bucarest, Rumanía" -- zero English
// word overlap despite being the right building), so an English-word-overlap
// check here rejects more good matches than bad ones.
async function fromCommons(query) {
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrnamespace: '6', gsrlimit: '1',
    prop: 'imageinfo', iiprop: 'url', iiurlwidth: '800', format: 'json', origin: '*'
  });
  const data = await getJson(`${COMMONS_API}?${params}`);
  const pages = data && data.query && data.query.pages;
  if (!pages) return null;
  for (const key of Object.keys(pages)) {
    const info = pages[key] && pages[key].imageinfo && pages[key].imageinfo[0];
    const src = info && (info.thumburl || info.url);
    if (src) return src;
  }
  return null;
}

// Wikidata entities carry a short, deliberately geographic description (e.g.
// "square in Bucharest, Romania") that a bare Wikipedia article title doesn't
// -- that's what let "Revolution Square" wrongly resolve to Maribor,
// Slovenia's square of the same name even after the title-relevance filter,
// since BOTH titles are literally just "Revolution Square" with no country
// info in the title text to distinguish them. Preferring the Wikidata
// candidate whose description actually mentions the destination fixes this
// class of same-name-different-country collision that title-matching can't.
async function wikidataImageFor(query, destination) {
  const searchParams = new URLSearchParams({
    action: 'wbsearchentities', search: query, language: 'en', format: 'json', limit: '20', type: 'item', origin: '*'
  });
  const searchData = await getJson(`${WIKIDATA_API}?${searchParams}`);
  const candidates = (searchData && searchData.search) || [];
  if (!candidates.length) return null;

  // Only trust a candidate whose OWN description confirms the destination --
  // never guess with the top-ranked-but-unconfirmed result. Wikidata's label
  // search ranked Ljubljana/Krasnoyarsk/Maribor's "Revolution Square" entities
  // ABOVE Bucharest's for a bare "Revolution Square" query (Bucharest's was
  // 10th of 20), and Bucharest's own description ("square in central
  // Bucharest") doesn't even mention the country -- so a plain top-candidate
  // guess would still get this wrong. Falling through to the existing
  // Wikipedia/Commons chain (already relevance-filtered, already decent) is
  // strictly safer than Wikidata picking a wrong-country landmark with
  // confidence.
  const destWords = destination ? normalizeText(destination).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4) : [];
  const chosen = destWords.length
    ? candidates.find((c) => destWords.some((w) => normalizeText(c.description || '').includes(w)))
    : null;
  if (!chosen) return null;

  const entParams = new URLSearchParams({ action: 'wbgetentities', ids: chosen.id, props: 'claims', format: 'json', origin: '*' });
  const entData = await getJson(`${WIKIDATA_API}?${entParams}`);
  const claims = entData && entData.entities && entData.entities[chosen.id] && entData.entities[chosen.id].claims;
  const p18 = claims && claims.P18 && claims.P18[0] && claims.P18[0].mainsnak && claims.P18[0].mainsnak.datavalue && claims.P18[0].mainsnak.datavalue.value;
  if (!p18) return null;
  return `${COMMONS_FILEPATH_BASE}${encodeURIComponent(p18)}?width=800`;
}

// Place names throughout this app are formatted "<Hebrew> (<English>)" --
// stripping the parenthetical and searching English Wikipedia with what's
// LEFT (the Hebrew part) was backwards. A real run showed this concretely:
// "ארמון הפרלמנט (Palace of Parliament)" searched as pure Hebrew text almost
// never matches, so dozens of well-known, definitely-photographed landmarks
// fell through to the destination-wide fallback image instead of their own.
// The English parenthetical -- when present -- IS the useful search term;
// extract and prefer it, don't discard it.
function cleanQuery(q) {
  const s = String(q || '');
  const paren = s.match(/\(([^)]+)\)/);
  if (paren && paren[1].trim()) return paren[1].trim();
  return s.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchImageFor(query, destination) {
  const clean = cleanQuery(query);
  // Destination-qualified search FIRST, not as a fallback -- a real run
  // showed "Revolution Square" (a generic name that exists in many cities)
  // matching Paris's Place de la Concorde on the bare query alone, before the
  // destination-qualified attempt ever ran. Many extracted names are generic
  // enough (squares, clock towers, old towns) that the bare query is the
  // riskier one, not the safer default -- qualify first, bare name only as
  // a fallback for when adding the destination over-narrows a genuinely
  // well-known unique name and returns nothing.
  return (
    (await wikidataImageFor(clean, destination)) ||
    (destination ? await fromWikipedia(`${clean} ${destination}`, clean) : null) ||
    (await fromWikipedia(clean, clean)) ||
    (await fromCommons(destination ? `${clean} ${destination}` : clean)) ||
    (await fromCommons(clean)) ||
    null
  );
}

// A destination-level image, fetched once and reused as the guaranteed last
// resort so a card is NEVER imageless (personal use -- an on-topic photo
// beats a blank gradient). `regionHint` is accepted for call-site compat but
// deliberately NOT used as search text: region names in this app are Hebrew
// (e.g. "בוקרשט וסביבתה"), and searching English Wikipedia with raw Hebrew
// text doesn't fail cleanly -- it returns a confident-looking but unrelated
// top hit (a real run got a Romanian mountain-range photo, "Apuseni", from a
// Hebrew region-name query, then that ONE wrong result got reused across
// every place in that region that fell through to this fallback). Once the
// query is just the destination's English name, it's the same deterministic
// query for the whole trip, so a single cache entry (not one per region) is
// correct again -- no cross-region leakage risk once nothing region-specific
// feeds the query.
// Only successes are cached -- a transient failure on the FIRST call must not
// permanently poison every later place that needs this fallback. A real run
// showed exactly that: the first place to reach this fallback hit a one-off
// network blip, cached `null`, and every subsequent place needing a fallback
// for the rest of the ~25-minute run got null too instead of retrying.
const destImageCache = {};
async function getDestinationImage(destination) {
  const key = destination || 'x';
  if (destImageCache[key]) return destImageCache[key];
  let img = await fromWikipedia(destination);
  if (!img) img = await fromCommons(destination);
  if (img) destImageCache[key] = img;
  return img;
}

// Resolve an image for a single place, GUARANTEED non-null when the destination
// itself has any image: place -> place+dest -> commons -> destination fallback.
// `regionHint` is accepted for call-site compat only -- see getDestinationImage
// for why region names (Hebrew text) must never be used as search text.
async function resolveImageGuaranteed(name, destination, regionHint) {
  let img = await fetchImageFor(name, destination);
  if (!img) img = await getDestinationImage(destination);
  return img;
}

// MUST stay sequential, no exceptions. Earlier attempts at concurrency 8 then
// 4 both looked fine in small isolated tests but broke badly at full
// 109-place scale (up to 88% of places collapsing onto one shared fallback
// image). A direct side-by-side test proved why: 10 real place queries run
// one-at-a-time resolved 9/10 correctly; the SAME 10 run via Promise.all came
// back 0/10 -- not degraded, just gone. Concurrency 2 and 3 were tested too
// and still dropped results (6/8 and 4/8). This isn't a quality/ranking
// nuance, it's a hard rate-limit wall: Wikipedia's public search API silently
// fails (returns no result, not an error) under ANY concurrent burst from one
// client. Sequential costs ~25 min for 109 places -- accepted, since a wrong
// or generic-fallback photo directly violates the "every place has its own
// picture" requirement, and speed was never the priority image accuracy was.
// (A generic bounded-concurrency pool used to sit here -- pointless
// indirection for a concurrency level that will never be anything but 1.)
async function runSequential(items, worker) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i++) results[i] = await worker(items[i], i);
  return results;
}

// The destination fallback is the LAST safety net -- "every place has a
// picture" is a hard requirement, so it must not depend on live network
// timing in the middle of a long batch. A real 30-place run under batch load
// got 3 nulls from places whose fallback call hit a one-off transient blip;
// every one of them resolved fine when re-tried in isolation seconds later.
// Warming the (cached) destination image ONCE up front, with a few extra
// retries since it's a one-time cost, means every later per-place fallback
// is an instant cache hit instead of a fresh network call that can flake.
async function warmDestinationImage(destination) {
  for (let attempt = 0; attempt < 5; attempt++) {
    if (await getDestinationImage(destination)) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Resolve images for a list of highlights ({ imageQuery }), mutating each with
// `.image` (URL or null).
async function attachImages(highlights, onProgress, destination) {
  await warmDestinationImage(destination);
  let done = 0;
  await runSequential(highlights, async (h) => {
    // GUARANTEED image: model query -> bare name -> destination photo. (Not a
    // 3rd attempt via resolveImageGuaranteed(h.name) -- that call starts with
    // the exact same fetchImageFor(name, destination) the line above already
    // ran and failed; re-running a deterministic search is guaranteed to
    // repeat the same failure, just wasting a full throttled request cascade.)
    let img = await fetchImageFor(h.imageQuery || h.name, destination);
    if (!img && h.name && h.name !== h.imageQuery) img = await fetchImageFor(h.name, destination);
    if (!img) img = await getDestinationImage(destination);
    h.image = img;
    done++;
    if (onProgress) onProgress(`  image ${done}/${highlights.length}: ${h.image ? 'ok' : 'none'} (${h.name})`);
  });
  return highlights;
}

// Attach a guaranteed image to each place (used for the final showcase cards,
// where every selected place must show a photo). Mutates each with `.image`.
async function attachImagesToPlaces(places, destination, onProgress) {
  await warmDestinationImage(destination);
  let done = 0;
  await runSequential(places, async (p) => {
    p.image = await resolveImageGuaranteed(p.name, destination, p.regionName);
    done++;
    if (onProgress && (done % 10 === 0 || done === places.length)) onProgress(`  place images ${done}/${places.length}...`);
  });
  return places;
}

module.exports = { fetchImageFor, attachImages, attachImagesToPlaces, resolveImageGuaranteed, getDestinationImage };
