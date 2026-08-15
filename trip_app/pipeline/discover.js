// Stage: destination -> real sources + candidate URLs to mine. The ONE place
// in this app that still uses `claude -p` -- because it's the one step that
// never actually failed in the old system. Every real failure this project
// hit (backgrounded mining, Monitor misuse, timeouts) came from asking Claude
// to ORCHESTRATE a long multi-step pipeline. This call does neither: it gets
// WebSearch and nothing else, runs one bounded turn, and returns JSON as its
// final message. There is no Bash to background, no file to half-write, no
// Monitor to reach for -- those tools simply aren't in its toolset, so the
// whole class of failure is structurally impossible here, not just discouraged
// by prompt wording.

const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const { loadEnvLocal } = require('../../lib/loadEnv');

const ROOT = path.join(__dirname, '..', '..');
loadEnvLocal(ROOT); // ANTHROPIC_API_KEY -- without this the spawned claude -p session has no auth at all
const KNOWLEDGE_HUBS_PATH = path.join(ROOT, 'Knowledge_Hubs.md');

const CLAUDE_BIN = (() => {
  const npmGlobal = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
  return fs.existsSync(npmGlobal) ? npmGlobal : 'claude';
})();

const DISCOVER_TIMEOUT_MS = 6 * 60 * 1000; // WebSearch-only calls are fast; generous headroom
const DISCOVER_BUDGET_USD = '1';
const DISCOVER_MODEL = 'claude-haiku-4-5'; // search + summarize, not judgment -- cheapest tier is enough

// Parse "- **Name** — domain.com — note" bullets out of Knowledge_Hubs.md.
function parseKnowledgeHubs() {
  if (!fs.existsSync(KNOWLEDGE_HUBS_PATH)) return [];
  const text = fs.readFileSync(KNOWLEDGE_HUBS_PATH, 'utf-8');
  const out = [];
  const re = /^- \*\*(.+?)\*\* — ([a-zA-Z0-9.-]+\.[a-zA-Z]{2,}) — (.+)$/gm;
  let m;
  while ((m = re.exec(text))) {
    out.push({ name: m[1].trim(), domain: m[2].trim(), note: m[3].trim() });
  }
  return out;
}

// type is one of a fixed small set so the Sources page (Tab 2) can group by
// it consistently regardless of destination -- not a free-form label.
const SOURCE_TYPES = ['כללי', 'הייקינג וטבע', 'אוכל ויין', 'תרבות והיסטוריה', 'מקומי ועירוני'];

const RESULT_SCHEMA_HINT = `{
  "sources": [
    { "name": "Source Name", "domain": "example.com", "type": "${SOURCE_TYPES[0]}", "urls": ["https://example.com/page1", "..."] }
  ]
}`;

function buildPrompt(destinationHe, destinationEn, hubs) {
  const hubList = hubs.map((h) => `- ${h.name} (${h.domain})`).join('\n');
  return `אתה עוזר למצוא מקורות ודפים אמיתיים לתכנון טיול. שימוש ב-WebSearch בלבד -- אין לך גישה לכלים אחרים, אל תנסה.

יעד הטיול: ${destinationHe}${destinationEn && destinationEn !== destinationHe ? ` (${destinationEn})` : ''}
אם שם היעד עמום או חופף עם משהו מוכר יותר (למשל מדינה מול עיר/מחוז באותו שם), נמק זאת מפורשות בשאילתות החיפוש שלך כדי לא לסטות ליעד הלא נכון.

רשימת מקורות מאושרים לבדיקה (מהאינדקס הקבוע שלנו):
${hubList}

המשימה:
1. עבור כל מקור ברשימה למעלה: חיפוש קל אחד (site:<domain> ${destinationHe} או ${destinationHe} <שם המקור>) כדי לבדוק אם יש לו תוכן אמיתי על היעד. אם כן -- מצא עד 5 כתובות URL אמיתיות וספציפיות (לא דף הבית הכללי) שסביר שיש בהן מידע מפורט על מקומות ביעד. אם אין תוכן רלוונטי -- דלג על המקור (אל תכלול אותו בפלט).
2. בנוסף, חפש בעברית ובאנגלית אחר עד 3 מקורות איכותיים חדשים (בלוגים/מדריכים עם עומק אמיתי, לא אתרי SEO גנריים) שלא ברשימה למעלה ויש להם תוכן ממוקד ליעד הזה -- כלול גם אותם באותו פורמט.
3. לכל מקור (גם מהרשימה הקבועה וגם חדש) קבע type אחד בדיוק מתוך: ${SOURCE_TYPES.join(' / ')}. לפי התוכן בפועל שהמקור מציע ליעד הזה, לא לפי הנושא הכללי של האתר.
4. מקסימום כ-15 חיפושים בסך הכל. חיפוש snippet בלבד -- אל תבצע WebFetch על אף עמוד.

החזר אך ורק JSON תקני בפורמט הבא, ללא טקסט נוסף, ללא markdown fencing:
${RESULT_SCHEMA_HINT}`;
}

// Extract a JSON object from the model's final text, defensively (in case it
// wraps the JSON in a markdown fence despite being told not to).
function extractJson(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in discovery output');
  return JSON.parse(candidate.slice(start, end + 1));
}

function discoverSources(destinationHe, destinationEn, onProgress) {
  const log = onProgress || (() => {});
  return new Promise((resolve, reject) => {
    const hubs = parseKnowledgeHubs();
    const prompt = buildPrompt(destinationHe, destinationEn, hubs);

    const args = [
      '--permission-mode', 'bypassPermissions',
      '--strict-mcp-config',
      '--output-format', 'json',
      '--max-budget-usd', DISCOVER_BUDGET_USD,
      '--model', DISCOVER_MODEL,
      // The actual safety mechanism: WebSearch is the ONLY tool this session
      // can call. No Bash to background, no Write to half-finish, no Monitor/
      // ScheduleWakeup to misuse -- they are not in its toolset at all.
      '--allowedTools', 'WebSearch',
      '-p'
    ];

    log(`מתחיל גילוי מקורות ל-${destinationHe} (מודל: ${DISCOVER_MODEL}, ${hubs.length} מקורות קבועים לבדיקה)...`);

    let stdoutBuf = '';
    let stderrBuf = '';
    const child = spawn(CLAUDE_BIN, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], shell: true, windowsHide: true });
    child.stdout.on('data', (c) => { stdoutBuf += c; });
    child.stderr.on('data', (c) => { stderrBuf += c; });
    child.stdin.write(prompt);
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log('גילוי מקורות עבר את זמן ה-timeout — מחסל את התהליך.');
      exec(`taskkill /PID ${child.pid} /T /F`, () => {});
    }, DISCOVER_TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { reject(new Error('Source discovery timed out')); return; }
      let parsed;
      try {
        parsed = JSON.parse(stdoutBuf.trim());
      } catch (err) {
        reject(new Error(`Discovery session produced no valid output (exit ${code}): ${stderrBuf.slice(0, 300)}`));
        return;
      }
      const costUsd = parsed.total_cost_usd || 0;
      let resultJson;
      try {
        resultJson = extractJson(parsed.result || '');
      } catch (err) {
        reject(new Error(`Discovery result was not valid JSON: ${err.message}`));
        return;
      }
      // `standing` (mandatory-list vs. newly-discovered) is computed here from
      // the actual hub domain set, not trusted from the model's own claim --
      // it already has this exact list, no need to have it self-report
      // membership in something we can check deterministically.
      const hubDomains = new Set(hubs.map((h) => h.domain));
      const sources = (resultJson.sources || [])
        .filter((s) => s.domain && Array.isArray(s.urls) && s.urls.length)
        .map((s) => ({
          ...s,
          standing: hubDomains.has(s.domain),
          type: SOURCE_TYPES.includes(s.type) ? s.type : SOURCE_TYPES[0]
        }));
      const standingCount = sources.filter((s) => s.standing).length;
      log(`גילוי מקורות הסתיים | עלות: $${costUsd.toFixed(4)} | ${sources.length} מקורות רלוונטיים נמצאו (${standingCount} קבועים, ${sources.length - standingCount} חדשים)`);
      resolve({ sources, costUsd });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { discoverSources, parseKnowledgeHubs, SOURCE_TYPES };
