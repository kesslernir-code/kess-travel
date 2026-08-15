// Loads .env.local (ANTHROPIC_API_KEY, GEMINI_API_KEY, ...) into process.env.
// Shared by trip_watcher.js and any standalone script (e.g. lib/mine_pipeline.js)
// that runs outside the claude -p / headless-CLI path and so needs its own
// credentials loaded the same way.
const fs = require('fs');
const path = require('path');

function loadEnvLocal(rootDir) {
  const envPath = path.join(rootDir, '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key && value && !process.env[key]) process.env[key] = value;
  }
}

module.exports = { loadEnvLocal };
