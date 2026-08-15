// Shared Gemini client + retry helper. Every call site in this pipeline
// (lib/gemini.js, pipeline/organize.js, pipeline/enrich.js,
// pipeline/finalplan.js) used to hand-roll its own copy of "one client
// instance + a generateContent-vs-timeout race + a retry loop on transient
// errors" -- and the copies had already drifted: enrich.js had NO retry at
// all (a single attempt, so a transient 503 that the other three would
// survive killed the whole enrich stage), and lib/gemini.js's retry regex
// excluded "timed out" as a retryable condition while the other two included
// it. One shared implementation instead of four independently-maintained ones.

const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAIInstance = null;
function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set (add it to .env.local)');
  if (!genAIInstance) genAIInstance = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAIInstance;
}

const DEFAULT_RETRY_DELAYS_MS = [3000, 8000, 15000];
const RETRYABLE_PATTERN = /timed out|503|429|overloaded|high demand/i;

// One generateContent call, raced against a timeout, retried on transient
// failures (timeout / 503 "high demand" / 429 overload -- all confirmed real,
// transient conditions seen in production, not just quota exhaustion).
async function callGeminiWithRetry(model, prompt, { timeoutMs = 120000, timeoutLabel = 'Gemini call', retryDelays = DEFAULT_RETRY_DELAYS_MS } = {}) {
  let result;
  let lastErr;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    let timeoutHandle;
    try {
      result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`)), timeoutMs);
        })
      ]);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!RETRYABLE_PATTERN.test(err.message) || attempt === retryDelays.length) break;
      console.error(`  ${timeoutLabel} failed (attempt ${attempt + 1}/${retryDelays.length + 1}, retrying): ${err.message.slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, retryDelays[attempt]));
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
  if (lastErr) throw lastErr;
  return result;
}

module.exports = { getGeminiClient, callGeminiWithRetry };
