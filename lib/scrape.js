// Stage B (part 1) of the Gemini-based mining pipeline: URL -> clean text.
// Uses Jina Reader (r.jina.ai) -- free, no API key, converts a page's real
// content (not raw HTML) into clean markdown-ish text. This replaced Claude's
// own WebFetch inside mining subagents, which is where the real cost/failure
// problems this session all traced back to.
//
// Deliberately zero-LLM: this file makes exactly one HTTP GET per URL and
// returns text. No retries-with-backoff-forever, no cleverness -- a failed
// scrape is just skipped by the caller, same philosophy as a subagent hitting
// its call cap and moving on.

const JINA_BASE = 'https://r.jina.ai/';
const SCRAPE_TIMEOUT_MS = 20000;

// Big sites (Lonely Planet, etc.) render a huge global nav/mega-menu ahead of
// the actual article -- a real Romania page came back with 105,000 chars of
// pure navigation before the word "Transylvania" ever appeared, silently
// eating the entire MAX_TEXT_CHARS cap and leaving Gemini nothing real to
// extract from (0 points, for every single Lonely Planet URL in a real run).
// Nav lines in Jina's markdown are near-100% link syntax with almost no prose
// outside the brackets ("[Japan](url)[Iceland](url)..."); real article
// prose is mostly plain text with at most an occasional inline link. Strip
// any line where removing all `[text](url)` leaves under 20 real characters,
// so truncation afterward actually lands on article content.
function stripNavLines(text) {
  const LINK_RE = /\[[^\]]*\]\([^)]*\)/g;
  return text.split('\n').filter((line) => {
    if (!LINK_RE.test(line)) return true; // no links at all -- definitely real content, keep
    const withoutLinks = line.replace(LINK_RE, '').replace(/\s+/g, ' ').trim();
    return withoutLinks.length >= 20;
  }).join('\n');
}

// A real test against a live, unusually large page (a full Wikipedia article,
// nav/footer/infobox cruft included) came back at 288,194 chars and pushed
// the Gemini extraction step past its timeout. A real travel blog page is
// normally far smaller than that, but capping here protects both latency and
// input-token cost against that kind of outlier regardless of how it
// happens -- an extraction working from the first ~50K chars of a page is a
// far cheaper problem than one that times out and gets skipped entirely.
const MAX_TEXT_CHARS = 50000;

// Jina's free tier is rate-limited but undocumented precisely -- a small
// stagger between calls (set by the caller looping over URLs) avoids the
// most common failure mode without adding real latency to a handful of URLs.
async function scrapeToText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);
  try {
    const res = await fetch(JINA_BASE + url, {
      signal: controller.signal,
      headers: {
        // Markdown is the most token-efficient clean format for the next
        // stage (Gemini) to read -- no need for Jina's raw HTML mode.
        'X-Return-Format': 'markdown'
      }
    });
    if (!res.ok) {
      throw new Error(`Jina Reader returned HTTP ${res.status} for ${url}`);
    }
    let text = await res.text();
    if (!text || text.trim().length < 50) {
      throw new Error(`Jina Reader returned suspiciously little content (${text.length} chars) for ${url}`);
    }
    // Jina itself reports these as page-level failures inside a 200 response
    // (a WAF blocking the fetch, or a JS app it can't render) -- passing this
    // text to Gemini anyway just burns a call that will always return 0
    // points with no indication why. Two real sites hit these on a real run:
    // Culture Trip's bot-detection WAF, and AllTrails' JS-only listing pages.
    if (/returned error 403|flagged this request as potentially malicious|requiring CAPTCHA|page maybe not yet fully loaded/i.test(text)) {
      throw new Error(`Jina Reader could not access the real page for ${url} (blocked or JS-only content)`);
    }
    text = stripNavLines(text);
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { scrapeToText };
