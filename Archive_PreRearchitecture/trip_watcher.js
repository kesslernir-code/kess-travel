// KESSLER_TRIP headless auto-trigger
// -----------------------------------------------------------------------
// Runs entirely on this computer. Watches this folder tree for three events
// and, when it sees one, launches Claude Code itself in headless mode
// (claude -p ...) to run the next pipeline stage(s) for that destination --
// no chat message from Nir required.
//
//   A1. <Destination>/<Destination>_Trip_Input.md is created (the local form
//       wrote it) and <Destination>_KESSLER_TRIP.html doesn't exist yet
//       -> runs new-trip-input (from Step 2 on) -> trip-scan. Stops there --
//          this is a real checkpoint, not a chain-through: the user reviews
//          Tab 2's source cards and checks which ones to actually mine.
//
//   A2. <Destination>/<Destination>_Sources_Selected.json is created or its
//       confirmedAt is newer than the last one this watcher handled (written
//       when the user checks sources on Tab 2 and clicks confirm)
//       -> runs trip-master-plan Part A (mining ONLY the confirmed domains)
//          -> trip-master-plan Part B (route map, its own session/budget --
//          split from Part A after a real run showed Part A alone eating
//          almost the entire combined budget and leaving nothing for the map)
//          -> destination-showcase.
//
//   B.  <Destination>/<Destination>_Selection.json is created or its
//       confirmedAt is newer than the last one this watcher handled
//       -> runs final-trip-planner.
//
// Idempotent: every pre-existing Trip_Input.md / Sources_Selected.json /
// Selection.json is seeded as "already handled" the moment this process
// starts (same philosophy as local_server.js's dashboard auto-open watcher)
// -- only genuinely new files or genuinely new confirmations, from this
// point on, trigger a run. A failed run is not retried automatically;
// resubmitting the form (or re-clicking a confirm button) writes a fresh
// file/timestamp and will naturally retrigger.
//
// Runs are serialized one at a time (a queue), so two destinations
// submitted back to back don't fight over API budget at once.
//
// Start it by double-clicking start_trip_watcher.bat, or:
//   node trip_watcher.js
// Leave the window open (or launch it hidden via start_kessler_trip.vbs).
//
// Safety notes (read before changing the CLAUDE_ARGS below):
// - --permission-mode bypassPermissions is required because nobody is
//   present to click "allow" on anything -- but Claude Code has no OS-level
//   sandbox, so this does NOT hard-restrict Bash/file-tool access to this
//   folder. Scoping to "Trip Planner only" here rests on: cwd is fixed to
//   this folder, no --add-dir is passed, and the skill files being followed
//   only ever reference paths inside a destination's own folder.
// - --strict-mcp-config with no --mcp-config means this headless session
//   loads zero MCP servers -- it can't reach Gmail/Calendar/Supabase/etc.
//   even if a prompt went off the rails.
// - --max-budget-usd is a hard per-run cost ceiling (see CLAUDE_ARGS below).

const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const ROOT = __dirname; // this script must live directly inside the "Trip Planner" folder
const LOGS_DIR = path.join(ROOT, 'logs');
const SKIP_DIRS = new Set(['Skills_Reference', 'logs', 'node_modules', '.git']);

// Load .env.local (CLAUDE_CODE_OAUTH_TOKEN=..., GEMINI_API_KEY=...) so both
// headless claude.cmd runs and the standalone Gemini mining pipeline (see
// lib/mine_pipeline.js) are authenticated without relying on any global/
// permanent env var setup. Shared loader -- see lib/loadEnv.js.
require('./lib/loadEnv').loadEnvLocal(ROOT);

const CLAUDE_BIN = (() => {
  const npmGlobal = path.join(process.env.APPDATA || '', 'npm', 'claude.cmd');
  return fs.existsSync(npmGlobal) ? npmGlobal : 'claude';
})();

const BASE_ARGS = [
  '--permission-mode', 'bypassPermissions',
  '--strict-mcp-config',
  '--output-format', 'json' // single-result JSON so we can read total_cost_usd -- see runSkillStep
];

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });

// ---- Daily spend circuit breaker ---------------------------------------
// A run once burned $14.84 in one shot before anyone was watching. This is
// an independent backstop from Anthropic's own account limits: it never
// lets THIS watcher start a new step once today's own recorded total (from
// real total_cost_usd values, not an estimate) crosses the ceiling below --
// refuses outright rather than silently draining the account further.
const DAILY_SPEND_LIMIT_USD = 25;
const DAILY_SPEND_FILE = path.join(LOGS_DIR, 'daily_spend.json');

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function readSpendLedger() {
  try { return JSON.parse(fs.readFileSync(DAILY_SPEND_FILE, 'utf-8')); } catch { return {}; }
}
function getTodaySpend() {
  return readSpendLedger()[todayKey()] || 0;
}
function recordSpend(amountUsd) {
  if (!(amountUsd > 0)) return;
  const ledger = readSpendLedger();
  const key = todayKey();
  ledger[key] = (ledger[key] || 0) + amountUsd;
  fs.writeFileSync(DAILY_SPEND_FILE, JSON.stringify(ledger, null, 2), 'utf-8');
}

// Per-TRIP hard cap, independent of the daily cap above (which is global
// across every destination and only catches a runaway once a WHOLE day's
// spend crosses $25 -- far too coarse to bound one specific trip). This is a
// tunable ceiling for the current round of testing the new Gemini-based
// architecture -- lower than the $10 the per-step budgets are sized to sum
// to, on purpose, until there's real cost data to trust that total again.
const TRIP_SPEND_LIMIT_USD = 4;
const TRIP_SPEND_FILE = path.join(LOGS_DIR, 'trip_spend.json');

function readTripSpendLedger() {
  try { return JSON.parse(fs.readFileSync(TRIP_SPEND_FILE, 'utf-8')); } catch { return {}; }
}
function getTripSpend(dest) {
  return readTripSpendLedger()[dest] || 0;
}
function recordTripSpend(dest, amountUsd) {
  if (!(amountUsd > 0)) return;
  const ledger = readTripSpendLedger();
  ledger[dest] = (ledger[dest] || 0) + amountUsd;
  fs.writeFileSync(TRIP_SPEND_FILE, JSON.stringify(ledger, null, 2), 'utf-8');
}

function log(msg) {
  const line = `[${new Date().toLocaleString('he-IL')}] ${msg}`;
  console.log(line);
}

function safeStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ---- Prompts ------------------------------------------------------------
//
// Stage A used to be ONE combined claude -p session covering all four
// skills back to back. That meant every skill's context piled onto the
// same growing conversation, and every later turn re-read (from cache) all
// the accumulated context from every earlier skill -- most of the real
// dollar cost of a run was exactly this compounding cache-read, not the
// actual research. Splitting it into separate sessions, one per skill/skill
// group, resets that context between them: each skill already reads its
// own inputs straight from disk (Sources.md, Master_Plan.md, ...), so nothing
// is lost by not sharing a conversation. This also lets each step pick its
// own model -- the two purely mechanical steps (folder/dashboard scaffolding,
// source relevance checks) run on Haiku; the steps needing real judgment
// (deep source mining, map building, curation) stay on the default model.

function promptInputAndScan(dest) {
  return `זוהי הרצה אוטומטית (headless) של שלב 1(המשך)+2 בפייפליין KESSLER_TRIP עבור היעד "${dest}". אל תשאל שום שאלה — אין מי שיענה; בכל נקודת החלטה קבל בעצמך את הבחירה הסבירה ביותר ותמשיך.

קובץ ${dest}/${dest}_Trip_Input.md כבר קיים (הוגש דרך הטופס המקומי) — שלב 1 (איסוף פרטים) בוצע.

1. קרא את Skills_Reference/new-trip-input_SKILL.md. דלג לגמרי על Step 1 (השאלות בצ'אט). בצע את Step 2 (ודא שהתיקייה ${dest}/ קיימת ותקינה) ואת Step 3 (בניית ${dest}_KESSLER_TRIP.html מ-kessler_trip_shell_template.html, כולל מילוי טאב 1).
2. קרא את Skills_Reference/trip-scan_SKILL.md ובצע אותו במלואו עבור ${dest} (כולל שלב 3 — חיפוש מקורות חדשים).

בסיום, ${dest}_KESSLER_TRIP.html ו-${dest}_Sources.md אמורים להיות קיימים. אל תדפיס שום דבר מעבר לפעולות עצמן.`;
}

// Part A no longer mines via Claude subagents at all -- see the "Architecture
// note" at the top of trip-master-plan_SKILL.md. Claude only finds URLs
// (WebSearch, no WebFetch) and organizes the already-extracted result; the
// actual page-reading and extraction is a plain Node script (lib/mine_pipeline.js)
// calling Gemini 1.5 Flash, invoked via this session's own Bash tool. This is
// what replaced two consecutive real, total-loss failures ($3.01 then $4.26,
// zero output either time) from the old subagent-based design.
function promptMasterPlan(dest) {
  return `זוהי הרצה אוטומטית (headless) של שלב 3 (Part A בלבד) בפייפליין KESSLER_TRIP עבור היעד "${dest}". אל תשאל שום שאלה — אין מי שיענה; בכל נקודת החלטה קבל בעצמך את הבחירה הסבירה ביותר ותמשיך.

${dest}_Sources_Selected.json כבר קיים (המשתמש בחר וסימן בצ'ק-בוקס אילו מקורות מתוך ${dest}_Sources.html לכרות, ולחץ אישור). קרא את Skills_Reference/trip-master-plan_SKILL.md ובצע **רק את Part A** עבור ${dest} — Step 1 המעודכן אומר לך לכרות **רק** את המקורות שמופיעים ב-${dest}_Sources_Selected.json, לא את כל ${dest}_Sources.md.

**שים לב: הארכיטקטורה השתנתה.** Part A כבר לא כורה תוכן בעצמו (Step 2 מוצא רק URLs עם WebSearch, בלי שום WebFetch); שלב הכרייה האמיתי הוא סקריפט Node נפרד (Step 2b: \`node lib/mine_pipeline.js "${dest}"\` דרך כלי ה-Bash) שקורא ל-Gemini 1.5 Flash, ולא לקלוד בכלל. הרץ אותו וחכה שיסתיים — זה עולה כמעט אפס בטוקנים של קלוד, כי אתה רק חסום על קריאת Bash, לא מייצר תוכן.

**אל תתחיל את Part B (בניית המפה) בהרצה הזו — זו הרצה נפרדת, בהמשך, עם budget משלה.**

בסיום, ${dest}_Master_Plan.md אמור להיות קיים. אל תדפיס שום דבר מעבר לפעולות עצמן.`;
}

function promptRouteMap(dest) {
  return `זוהי הרצה אוטומטית (headless) של שלב 3 (Part B בלבד — בניית המפה) בפייפליין KESSLER_TRIP עבור היעד "${dest}". אל תשאל שום שאלה — אין מי שיענה; בכל נקודת החלטה קבל בעצמך את הבחירה הסבירה ביותר ותמשיך.

${dest}_Master_Plan.md כבר קיים (נכתב בהרצה קודמת, נפרדת, של Part A — אל תבנה אותו מחדש ואל תכרה מקורות בהרצה הזו). קרא את Skills_Reference/trip-master-plan_SKILL.md ובצע **רק את Part B**: בנה את ${dest}_Route_Map.html מתוך ${dest}_Master_Plan.md הקיים, כולל הוויירינג לשרת המקומי, כל הדרישות (naming contract, הדגשת אזור עם Circle, כפתור הצעת בחירה) ואת שלב 6b (הרצת tools/verify_route_map.js לפני שסיימת). עדכן גם את טאב 4 בדשבורד כמתואר בשלב 7 של הסקיל.

בסיום, ${dest}_Route_Map.html אמור להיות קיים ומוכן לבחירה. אל תדפיס שום דבר מעבר לפעולות עצמן.`;
}

function promptShowcase(dest) {
  return `זוהי הרצה אוטומטית (headless) של שלב 4 בפייפליין KESSLER_TRIP עבור היעד "${dest}". אל תשאל שום שאלה — אין מי שיענה; בכל נקודת החלטה קבל בעצמך את הבחירה הסבירה ביותר ותמשיך.

${dest}_Master_Plan.md כבר קיים. קרא את Skills_Reference/destination-showcase_SKILL.md ובצע אותו במלואו עבור ${dest}, כולל עדכון טאב 3 בדשבורד.

בסיום, ${dest}_Showcase.html אמור להיות קיים. אל תדפיס שום דבר מעבר לפעולות עצמן.`;
}

function promptStageB(dest) {
  return `זוהי הרצה אוטומטית (headless, ללא שום צ'אט אינטראקטיבי) של שלב 5 (האחרון) בפייפליין KESSLER_TRIP עבור היעד "${dest}".

קובץ ${dest}/${dest}_Selection.json כבר קיים עם הבחירה שאושרה במפה (${dest}_Route_Map.html דרך local_server.js) — אל תשאל שום שאלה ואל תמתין לתשובה מאף אחד.

קרא את Skills_Reference/final-trip-planner_SKILL.md ובצע את כל השלב עבור ${dest}, תוך קריאת הבחירה מ-${dest}_Selection.json ישירות (לא מהצ'אט — אין צ'אט). בכל נקודת החלטה שהייתה דורשת שיקול דעת, קבל בעצמך את הבחירה הסבירה ביותר בהתבסס על ${dest}_Trip_Input.md ותמשיך.

בסיום, ודא שהטאבים 5, 6 ו-7 ב-${dest}_KESSLER_TRIP.html מעודכנים עם התוצר הסופי.`;
}

// ---- Queue ----------------------------------------------------------------

const queue = [];
let busy = false;

function enqueue(job) {
  queue.push(job);
  processQueue();
}

async function processQueue() {
  if (busy) return;
  const job = queue.shift();
  if (!job) return;
  busy = true;
  try {
    if (job.type === 'A1') await runStageA1(job.dest);
    else if (job.type === 'A2') await runStageA2(job.dest);
    else await runStageB(job.dest);
  } catch (err) {
    log(`[${job.dest}] שגיאה בהרצת שלב ${job.type}: ${err.message}`);
  }
  busy = false;
  processQueue();
}

// Runs one skill (or small skill group) as its own claude -p session --
// fresh context every time, on purpose (see the note above the prompts).
// Returns true on exit code 0, false otherwise.
//
// A real incident: a run once hung for 3.5 hours on "response stalled
// mid-stream" and burned $14.84 across 465 turns before finally erroring out
// on its own -- --max-budget-usd only checks between turns, so a stall deep
// inside one turn (or a subagent stuck retrying) isn't caught by it at all.
// timeoutMs is an independent, wall-clock hard kill: no dollar accounting,
// no waiting for the process to decide it's stuck -- if it's still running
// past this, it gets killed and counted as a failure, same as any other.
function runSkillStep(dest, stepKey, prompt, { model, budget, timeoutMs = 20 * 60 * 1000, effort, expectedArtifact }) {
  return new Promise((resolve) => {
    const spentToday = getTodaySpend();
    if (spentToday >= DAILY_SPEND_LIMIT_USD) {
      log(`[${dest}] ${stepKey} לא הופעל — תקרת ההוצאה היומית ($${DAILY_SPEND_LIMIT_USD}) כבר נחצתה (הוצא היום: $${spentToday.toFixed(2)}). ערוך את DAILY_SPEND_LIMIT_USD ב-trip_watcher.js אם זה מכוון.`);
      resolve(false);
      return;
    }
    const spentOnTrip = getTripSpend(dest);
    if (spentOnTrip >= TRIP_SPEND_LIMIT_USD) {
      log(`[${dest}] ${stepKey} לא הופעל — תקרת העלות לטיול הזה ($${TRIP_SPEND_LIMIT_USD}) כבר נחצתה (הוצא על ${dest}: $${spentOnTrip.toFixed(2)}). ערוך את TRIP_SPEND_LIMIT_USD ב-trip_watcher.js אם זה מכוון.`);
      resolve(false);
      return;
    }

    const args = [...BASE_ARGS, '--max-budget-usd', budget];
    if (model) args.push('--model', model);
    // Sonnet 5 runs adaptive thinking + effort:"high" by default when neither is set explicitly --
    // thinking tokens bill as ordinary output tokens, so a mechanical, well-specified step (writing
    // HTML from an already-built Master_Plan.md, not open-ended research) doesn't need to pay for
    // that depth. --effort is the CLI's real lever here; there's no separate thinking-disable flag.
    if (effort) args.push('--effort', effort);
    args.push('-p');
    const logPath = path.join(LOGS_DIR, `${dest}_${stepKey}_${safeStamp()}.log`);
    // stderr goes straight to the log file in real time (so a mid-run error
    // like "Credit balance is too low" is visible immediately even if the
    // process never produces a final JSON result). stdout is piped instead
    // of going straight to the file, because --output-format json means it's
    // a single JSON blob we need to parse for total_cost_usd once complete.
    const logFd = fs.openSync(logPath, 'a');
    let stdoutBuf = '';

    log(`[${dest}] מתחיל ${stepKey}${model ? ` (מודל: ${model})` : ''} (לוג: ${path.basename(logPath)}, timeout: ${Math.round(timeoutMs / 60000)} דק')`);

    // The prompt is fed over stdin, never as a CLI argument -- a long,
    // multi-line Hebrew string with quotes gets silently mangled by
    // cmd.exe's argument parsing when passed through shell:true (only the
    // first word survives). stdin has no such parsing, so it survives intact.
    const child = spawn(CLAUDE_BIN, args, {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', logFd],
      shell: true,
      windowsHide: true
    });

    child.stdout.on('data', (chunk) => { stdoutBuf += chunk; });

    child.stdin.write(prompt);
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`[${dest}] ${stepKey} עבר את זמן ה-timeout (${Math.round(timeoutMs / 60000)} דק') — מחסל את התהליך.`);
      // shell:true means `child` is cmd.exe wrapping the real claude process --
      // killing just child.pid can leave the actual work orphaned and still
      // running/spending. taskkill /T kills the whole process tree under it.
      exec(`taskkill /PID ${child.pid} /T /F`, () => {});
    }, timeoutMs);

    // Without this, the log stays silent for the entire run and a user
    // watching it has no way to tell "still working, just slow" apart from
    // "actually hung" until the timeout above finally fires (up to 35 min).
    // A heartbeat every 3 min makes that distinction visible the whole time.
    const startedAt = Date.now();
    const HEARTBEAT_MS = 3 * 60 * 1000;
    const heartbeat = setInterval(() => {
      const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
      const timeoutMin = Math.round(timeoutMs / 60000);
      log(`[${dest}] ${stepKey} עדיין רץ — ${elapsedMin} מתוך ${timeoutMin} דק' (עדיין לפני timeout).`);
    }, HEARTBEAT_MS);

    function finish(success) {
      // Best-effort: --output-format json emits one JSON object on success.
      // On some failure paths (e.g. a mid-stream stall) it may emit plain
      // text instead -- if so there's no total_cost_usd to recover here,
      // but the wall-clock timeout above is what actually bounds the damage
      // in exactly that case, so this not finding a number is expected.
      let costUsd = 0, resultText = null;
      try {
        const parsed = JSON.parse(stdoutBuf.trim());
        costUsd = parsed.total_cost_usd || 0;
        resultText = parsed.result || null;
      } catch { /* no valid JSON -- see comment above */ }
      if (costUsd > 0) { recordSpend(costUsd); recordTripSpend(dest, costUsd); }

      // exit code 0 only means the CLI session ended cleanly -- it says nothing about
      // whether the step actually did its job. A real run had stepA2-master-plan exit
      // 0 after backgrounding its mining call and never writing Master_Plan.md, and the
      // two steps after it *also* exited 0 while explicitly reporting "the file I need
      // doesn't exist" in plain language -- all three got logged as successes and each
      // cost real money for nothing. If this step declares an expectedArtifact, exit
      // code alone can no longer be trusted; the file has to actually be there.
      let artifactMissing = false;
      if (success && expectedArtifact) {
        const artifactPath = path.join(ROOT, dest, `${dest}${expectedArtifact}`);
        if (!fs.existsSync(artifactPath)) {
          artifactMissing = true;
          success = false;
        }
      }

      fs.appendFileSync(logPath, `\n--- summary ---\ncost: $${costUsd.toFixed(4)} | today's total: $${(getTodaySpend()).toFixed(2)} of $${DAILY_SPEND_LIMIT_USD} | ${dest} total: $${getTripSpend(dest).toFixed(2)} of $${TRIP_SPEND_LIMIT_USD}${artifactMissing ? `\nSession exited cleanly but ${dest}${expectedArtifact} was never written -- treating this as a failure, not a success.` : ''}\n${resultText ? resultText + '\n' : ''}`, 'utf-8');
      fs.closeSync(logFd);
      log(`[${dest}] ${stepKey} ${success ? 'הסתיים' : 'נכשל'}${artifactMissing ? ` (הסשן יצא נקי אבל ${dest}${expectedArtifact} לא נכתב בפועל)` : ''} | עלות: $${costUsd.toFixed(2)} | סה"כ היום: $${getTodaySpend().toFixed(2)} | סה"כ ${dest}: $${getTripSpend(dest).toFixed(2)} מ-$${TRIP_SPEND_LIMIT_USD}`);
      resolve(success);
    }

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      finish(!timedOut && code === 0);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      fs.closeSync(logFd);
      log(`[${dest}] ${stepKey} נכשל להתחיל: ${err.message}`);
      resolve(false);
    });
  });
}

// Each of the two mechanical steps runs on Haiku; the steps needing real
// judgment (deep source mining, map building, curation, route building)
// stay on the account's default model. A failed step stops its own group --
// never runs a later skill against missing/stale input.
//
// Hard policy: an ENTIRE trip -- group A1 + group A2 (now three sub-steps) +
// Stage B, all of it -- must never be able to cost more than $10 in the worst
// case, full stop. The five budgets below are sized to sum to exactly that
// ($0.5 + $3 + $2 + $1.5 + $3 = $10). This was $8 until a real run showed
// trip-master-plan's Part A (mining + writing Master_Plan.md) alone eating
// $2.85-3.79 by itself -- bundling Part B (map-building) into that same $3
// session structurally starved it of any budget at all, which is exactly
// what happened (Master_Plan.md got written, Route_Map.html never did).
// Splitting master-plan into its own Part A step and a separate Part B
// (stepA2b-route-map) step, each with its own budget, means a Part A overrun
// can no longer silently zero out Part B's budget before it even starts --
// and the two failure modes now show up as two distinctly-named log lines
// instead of one confusing "stepA2-master-plan נכשל" with an ambiguous cause.
// Raising any one budget without lowering another breaks the $10 guarantee --
// don't do it without deciding the new total is genuinely acceptable. Real
// measured Stage B alone once cost $6.33 on its own default settings, well
// over its $3 share here -- see the matching cost-tightening applied to
// final-trip-planner_SKILL.md (fewer restaurant searches, bounded
// booking-checks) for the other half of how this budget is meant to
// actually be achievable, not just asserted.
// Every "judgment" step below used to pass model: null, on the assumption
// that omitting --model falls back to a reasonable default (Sonnet). A real
// recovery run proved that assumption wrong: with no --model flag, this
// environment's headless `claude -p` silently ran on claude-opus-4-8[1m] --
// $2.33 of a $2.33997 total came from Opus alone, against $0.0011 from Haiku
// on a tiny sub-task. Opus is roughly 5-7x Sonnet's per-token price, and this
// single default is almost certainly what's actually behind every budget
// overrun measured this session (stepA1's $1.31, stepA2's $3.79, the old
// $6.33 Stage B run) -- not just the subagent-model-omission bug fixed
// earlier in trip-scan_SKILL.md. Never omit --model again; always pin it
// explicitly, even for the "default" tier.
const JUDGMENT_MODEL = 'claude-sonnet-5';

// effort tuning (real cost lever, not cosmetic): Sonnet 5 defaults to
// adaptive thinking + effort:"high" whenever --effort is omitted, and
// thinking tokens bill as ordinary output tokens. Part A (mining + judging
// what's worth including) genuinely needs that depth -- leave it at the
// implicit default (no --effort). Part B (writing Route_Map.html from an
// already-fully-specified Master_Plan.md) and showcase (summarizing that
// same Master_Plan.md into an inspirational page) are comparatively
// mechanical -- structured generation from material that's already been
// researched, not open-ended judgment -- so they run at "medium". Stage B
// (final-trip-planner, own const below) stays at the implicit default too:
// day-by-day sequencing, driving times, and sleep-base logistics are exactly
// the kind of real reasoning this trip's actual itinerary quality rests on.
const STAGE_A1_STEPS = [
  { key: 'stepA1-input-scan', model: 'claude-haiku-4-5', budget: '0.5', timeoutMs: 10 * 60 * 1000, prompt: promptInputAndScan }
];
const STAGE_A2_STEPS = [
  // 35 min timeout, $3 budget: generous headroom for the FIRST real run of the
  // new Gemini-based mining pipeline (see trip-master-plan_SKILL.md's
  // "Architecture note") -- Claude itself now only does WebSearch-based URL
  // discovery, waits on one Bash call to lib/mine_pipeline.js (which paces
  // itself under both Jina Reader's and Gemini's rate limits -- a normal
  // 30-50 URL run takes a few minutes of wall-clock time but costs Claude
  // tokens for exactly one blocked Bash call, not per-URL reasoning), then
  // organizes the result. Real cost should end up far below $3 -- revisit
  // both numbers down once there's real data instead of guessing further.
  { key: 'stepA2-master-plan', model: JUDGMENT_MODEL, budget: '3', timeoutMs: 35 * 60 * 1000, prompt: promptMasterPlan, expectedArtifact: '_Master_Plan.md' },
  // Untested budget (no real run has reached Part B on its own yet) -- $2 is a
  // deliberately generous provision given how much map complexity (region
  // highlighting, auto-suggest, verification step) has been added this session.
  { key: 'stepA2b-route-map', model: JUDGMENT_MODEL, budget: '2', timeoutMs: 25 * 60 * 1000, prompt: promptRouteMap, effort: 'medium', expectedArtifact: '_Route_Map.html' },
  { key: 'stepA3-showcase', model: JUDGMENT_MODEL, budget: '1.5', timeoutMs: 15 * 60 * 1000, prompt: promptShowcase, effort: 'medium', expectedArtifact: '_Showcase.html' }
];

// Safety net: two real runs (Part B and showcase) each hit their budget cap
// right after finishing and saving their real artifact (Route_Map.html /
// Showcase.html -- both verified complete and correct) but *before* the
// final "update the dashboard tab" instruction could run. Trusting step
// ordering to always survive a mid-run budget cutoff isn't reliable -- this
// reconciles deterministically instead: for every known artifact suffix, if
// the file exists on disk but its tab still shows the placeholder, patch the
// tab directly. Pure file I/O, no API cost, safe to call unconditionally
// after every step (and once per destination at watcher startup, in case a
// past run left a dashboard stuck like this before this fix existed).
const TAB_ARTIFACTS = [
  { tab: 'TAB2', suffix: '_Sources.html' },
  { tab: 'TAB3', suffix: '_Showcase.html' },
  { tab: 'TAB4', suffix: '_Route_Map.html' },
  { tab: 'TAB5', suffix: '_Final_Map.html' },
  { tab: 'TAB6', suffix: '_Final_Showcase.html' },
  { tab: 'TAB7', suffix: '_Checklist.html' }
];

function reconcileDashboardTabs(dest) {
  const dashboardPath = path.join(ROOT, dest, `${dest}_KESSLER_TRIP.html`);
  if (!fs.existsSync(dashboardPath)) return;
  let html;
  try { html = fs.readFileSync(dashboardPath, 'utf-8'); } catch { return; }
  let changed = false;
  for (const { tab, suffix } of TAB_ARTIFACTS) {
    const artifactPath = path.join(ROOT, dest, `${dest}${suffix}`);
    if (!fs.existsSync(artifactPath)) continue;
    const startMarker = `<!-- ${tab}:START -->`;
    const endMarker = `<!-- ${tab}:END -->`;
    const startIdx = html.indexOf(startMarker);
    const endIdx = html.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) continue;
    const currentBlock = html.slice(startIdx + startMarker.length, endIdx);
    const expectedEmbed = `<iframe class="embed" src="${dest}${suffix}"></iframe>`;
    if (currentBlock.includes(expectedEmbed)) continue; // already wired up correctly
    html = html.slice(0, startIdx + startMarker.length) + `\n${expectedEmbed}\n` + html.slice(endIdx);
    changed = true;
    log(`[${dest}] תיקון אוטומטי: טאב ${tab} עודכן ל-${dest}${suffix} (הקובץ קיים על הדיסק אבל הטאב עדיין הצביע לפלייסהולדר).`);
  }
  if (changed) fs.writeFileSync(dashboardPath, html, 'utf-8');
}

async function runSteps(dest, steps, groupLabel) {
  for (const step of steps) {
    const ok = await runSkillStep(dest, step.key, step.prompt(dest), { model: step.model, budget: step.budget, timeoutMs: step.timeoutMs, effort: step.effort, expectedArtifact: step.expectedArtifact });
    reconcileDashboardTabs(dest);
    if (!ok) {
      log(`[${dest}] ${groupLabel} נעצר — ${step.key} נכשל, לא ממשיך לתת-השלבים הבאים.`);
      return;
    }
  }
  log(`[${dest}] ${groupLabel} הושלם במלואו.`);
}

async function runStageA1(dest) {
  await runSteps(dest, STAGE_A1_STEPS, 'שלב A1 (קלט+סריקה)');
}

async function runStageA2(dest) {
  await runSteps(dest, STAGE_A2_STEPS, 'שלב A2 (מאסטר-פלאן+showcase)');
}

async function runStageB(dest) {
  // Part of the same $10-per-trip hard cap as groups A1/A2 -- see the note above.
  await runSkillStep(dest, 'stageB-final-planner', promptStageB(dest), { model: JUDGMENT_MODEL, budget: '3', timeoutMs: 25 * 60 * 1000 });
  reconcileDashboardTabs(dest);
}

// ---- Watch state ------------------------------------------------------

const handledInputMtimeMs = new Map();     // destName -> mtimeMs already handled
const handledSourcesConfirmedAt = new Map(); // destName -> confirmedAt string already handled
const handledSelectionConfirmedAt = new Map(); // destName -> confirmedAt string already handled

function destFolders() {
  let entries;
  try { entries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name);
}

// Generic helper: seed a "last confirmedAt handled" map from any existing
// <dest>_<suffix> JSON file with a confirmedAt field, falling back to mtime
// if the JSON is malformed. Used identically for Sources_Selected.json and
// Selection.json -- same idempotency philosophy, same shape of file.
function seedConfirmedAtMap(map, suffix) {
  for (const dest of destFolders()) {
    const filePath = path.join(ROOT, dest, `${dest}${suffix}`);
    if (!fs.existsSync(filePath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      map.set(dest, data.confirmedAt || String(fs.statSync(filePath).mtimeMs));
    } catch {
      map.set(dest, String(fs.statSync(filePath).mtimeMs));
    }
  }
}

function seed() {
  for (const dest of destFolders()) {
    const inputPath = path.join(ROOT, dest, `${dest}_Trip_Input.md`);
    if (fs.existsSync(inputPath)) {
      handledInputMtimeMs.set(dest, fs.statSync(inputPath).mtimeMs);
    }
    // Self-heal any dashboard left stuck on a placeholder tab from a run that
    // predates this fix -- cheap, unconditional, runs once per destination.
    reconcileDashboardTabs(dest);
  }
  seedConfirmedAtMap(handledSourcesConfirmedAt, '_Sources_Selected.json');
  seedConfirmedAtMap(handledSelectionConfirmedAt, '_Selection.json');
  log(`אותחל: ${handledInputMtimeMs.size} טיולים עם קלט קיים, ${handledSourcesConfirmedAt.size} עם בחירת מקורות קיימת, ${handledSelectionConfirmedAt.size} עם בחירת מפה קיימת (כולם מסומנים כ"כבר טופלו").`);
}

function checkInputFile(dest, fullPath) {
  if (!fs.existsSync(fullPath)) return;
  let mtime;
  try { mtime = fs.statSync(fullPath).mtimeMs; } catch { return; }
  const prev = handledInputMtimeMs.get(dest);
  if (prev !== undefined && mtime <= prev) return;
  if (prev !== undefined && (mtime - prev) < DUPLICATE_CONFIRM_WINDOW_MS) {
    handledInputMtimeMs.set(dest, mtime); // record it as handled, but don't re-run for it
    log(`[${dest}] Trip_Input.md עודכן — התעלמות: הגיע ${Math.round(mtime - prev)}ms אחרי העדכון הקודם, כמעט בטוח הגשה כפולה של הטופס ולא עדכון מכוון.`);
    return;
  }
  handledInputMtimeMs.set(dest, mtime);

  const dashboardPath = path.join(ROOT, dest, `${dest}_KESSLER_TRIP.html`);
  if (fs.existsSync(dashboardPath)) {
    log(`[${dest}] Trip_Input.md עודכן אבל הדשבורד כבר קיים — לא מריץ שוב את שלב א'.`);
    return;
  }
  log(`[${dest}] טיול חדש זוהה — מוסיף לתור שלב A1.`);
  enqueue({ dest, type: 'A1' });
}

// A real double-click on a confirm button (before the UI-side fix -- see
// trip-scan_SKILL.md / trip-master-plan_SKILL.md's disable-on-click
// requirement) sent two POSTs moments apart, each writing a genuinely newer
// confirmedAt, and queued a full duplicate downstream run behind the real
// one. The UI fix should prevent this at the source now, but this is a
// second, independent line of defense at the file-watching level itself --
// belt and suspenders, since it costs nothing to check and a stale cached
// page or a browser back-button resubmit could still bypass the UI fix.
const DUPLICATE_CONFIRM_WINDOW_MS = 4000;

// Generic check for any *_Selected.json / *_Selection.json confirmation
// file: both files have the exact same {confirmedAt, ...} shape and the
// exact same "only a genuinely newer confirmedAt triggers a run" rule --
// only the map tracking what's already handled and the resulting job type
// differ between Tab 2's source confirmation and Tab 4's map confirmation.
function checkConfirmedAtFile(dest, fullPath, handledMap, jobType, logLabel) {
  if (!fs.existsSync(fullPath)) return;
  let confirmedAt;
  try {
    confirmedAt = JSON.parse(fs.readFileSync(fullPath, 'utf-8')).confirmedAt;
  } catch {
    return; // probably still mid-write; the next change event will catch it
  }
  if (!confirmedAt) return;
  const prev = handledMap.get(dest);
  if (prev !== undefined && confirmedAt <= prev) return;
  if (prev !== undefined && (Date.parse(confirmedAt) - Date.parse(prev)) < DUPLICATE_CONFIRM_WINDOW_MS) {
    handledMap.set(dest, confirmedAt); // record it as handled, but don't re-run for it
    log(`[${dest}] ${logLabel} — התעלמות: הגיע ${Date.parse(confirmedAt) - Date.parse(prev)}ms אחרי האישור הקודם, כמעט בטוח לחיצה כפולה ולא אישור מכוון.`);
    return;
  }
  handledMap.set(dest, confirmedAt);
  log(`[${dest}] ${logLabel} — מוסיף לתור שלב ${jobType}.`);
  enqueue({ dest, type: jobType });
}

function checkSourcesSelectionFile(dest, fullPath) {
  checkConfirmedAtFile(dest, fullPath, handledSourcesConfirmedAt, 'A2', 'בחירת מקורות חדשה/מעודכנת בטאב 2 זוהתה');
}

function checkSelectionFile(dest, fullPath) {
  checkConfirmedAtFile(dest, fullPath, handledSelectionConfirmedAt, 'B', 'בחירה חדשה/מעודכנת במפה זוהתה');
}

const debounceTimers = new Map();
function debounced(fullPath, fn) {
  clearTimeout(debounceTimers.get(fullPath));
  debounceTimers.set(fullPath, setTimeout(fn, 500));
}

function onRawEvent(eventType, filename) {
  if (!filename) return;
  const parts = filename.split(path.sep);
  if (parts.length !== 2) return; // only care about <Dest>/<file>, not deeper or root-level files
  const [dest, base] = parts;
  if (SKIP_DIRS.has(dest)) return;
  const fullPath = path.join(ROOT, filename);

  if (base === `${dest}_Trip_Input.md`) {
    debounced(fullPath, () => checkInputFile(dest, fullPath));
  } else if (base === `${dest}_Sources_Selected.json`) {
    debounced(fullPath, () => checkSourcesSelectionFile(dest, fullPath));
  } else if (base === `${dest}_Selection.json`) {
    debounced(fullPath, () => checkSelectionFile(dest, fullPath));
  }
}

// Windows' recursive fs.watch is documented as experimental and can quietly
// stop delivering events after a while. This periodic re-scan is a safety
// net on top of it, not a replacement -- it calls the exact same idempotent
// checks, so it can never double-trigger something fs.watch already caught.
const POLL_INTERVAL_MS = 15000;
function pollAll() {
  for (const dest of destFolders()) {
    checkInputFile(dest, path.join(ROOT, dest, `${dest}_Trip_Input.md`));
    checkSourcesSelectionFile(dest, path.join(ROOT, dest, `${dest}_Sources_Selected.json`));
    checkSelectionFile(dest, path.join(ROOT, dest, `${dest}_Selection.json`));
  }
}

function start() {
  seed();
  try {
    fs.watch(ROOT, { recursive: true }, onRawEvent);
    log(`עוקב אחרי ${ROOT} ... (claude: ${CLAUDE_BIN})`);
  } catch (err) {
    log(`שגיאה קריטית: ה-watcher לא הצליח להתחיל: ${err.message}`);
    process.exitCode = 1;
  }
  setInterval(pollAll, POLL_INTERVAL_MS);
}

start();
