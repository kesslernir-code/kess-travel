// Stage: organized data -> the HTML/Markdown artifacts.
//
// PURE TEMPLATING. No LLM, no network -- data in, files' text out. This is the
// stage that used to be done by `claude -p` writing HTML freehand (slow,
// expensive, non-deterministic, and the source of the "session exited but the
// file was never written" failures). Here the same output is a deterministic
// function of the data, so it either renders or throws -- it can never
// half-succeed. Reuses the existing artifacts' exact design system
// (cream/gold/accent) so the output is visually identical to the old pipeline.

const SHARED_VARS = `--ink:#241f1a;--paper:#faf6ef;--muted:#6b6157;--gold:#c8a24a;--accent:#a13d3d;`;

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The 5 page-render functions below each repeated this exact DOCTYPE/head/
// :root-reset boilerplate. `extraCss` is each page's OWN css (including its
// own `body {...}` rule -- these differ subtly per page, e.g. Sources.html's
// line-height, so they stay caller-owned rather than hardcoded here).
function htmlShell(title, extraCss, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<style>
  :root { ${SHARED_VARS} }
  * { box-sizing:border-box; }
${extraCss}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// The four display buckets the Master Plan groups by, mapping Gemini's 6
// extraction categories down: Food/Sleep/Other all fold into "אחר".
const BUCKETS = [
  { key: 'Nature', he: 'טבע ונוף', cats: ['Nature'] },
  { key: 'Urban', he: 'אורבני', cats: ['Urban'] },
  { key: 'Attraction', he: 'אטרקציות', cats: ['Attraction'] },
  { key: 'Other', he: 'אחר', cats: ['Food', 'Sleep', 'Other'] }
];

function bucketOf(category) {
  const b = BUCKETS.find((x) => x.cats.includes(category));
  return b ? b.key : 'Other';
}

// ---- Master Plan (Markdown) ------------------------------------------------
function renderMasterPlanMd(plan, meta) {
  const { destination } = plan;
  const lines = [];
  lines.push(`# Trip Master Plan: ${destination}`);
  lines.push(`*נבנה ${meta.builtAt} מ-${meta.sourceCount} מקורות, ${meta.pointCount} נקודות*`);
  lines.push('');
  lines.push('## תוכן עניינים');
  for (const r of plan.regions) lines.push(`- ${r.name}`);
  lines.push('');
  for (const r of plan.regions) {
    lines.push(`## ${r.name}`);
    lines.push('');
    for (const b of BUCKETS) {
      const inBucket = r.places.filter((p) => bucketOf(p.category) === b.key);
      if (inBucket.length === 0) continue;
      lines.push(`### ${b.he} (${b.key})`);
      for (const p of inBucket) {
        const src = p.sources && p.sources.length ? ` (מקור: ${p.sources.join(', ')})` : '';
        const star = p.recommended ? '⭐ ' : '';
        lines.push(`- **${star}${p.name}** — ${p.description}${src}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

// ---- Dashboard shell (7 tabs) ----------------------------------------------
function renderDashboard(destination, input, tabState) {
  // tabState: { '2': true, '3': true, ... } which tabs have real content vs placeholder
  const TABS = [
    { n: 1, label: '1. נתוני טיול' },
    { n: 2, label: '2. מקורות מחקר', file: '_Sources.html' },
    { n: 3, label: '3. עמוד רקע', file: '_Showcase.html' },
    { n: 4, label: '4. מפה ומסלול', file: '_Route_Map.html' },
    { n: 5, label: '5. מסלול סופי', file: '_Final_Map.html' },
    { n: 6, label: '6. Showcase ממוקד', file: '_Final_Showcase.html' },
    { n: 7, label: '7. צ\'ק-ליסט הזמנות', file: '_Checklist.html' }
  ];
  const fields = [
    ['לאיפה', input.destination],
    ['מתי וכמה זמן', input.dates],
    ['כמה משתתפים', input.participants],
    ['הרכב המשתתפים', input.composition],
    ['התניידות', input.transport],
    ['דגשים מיוחדים', input.emphases]
  ].filter(([, v]) => v);

  const tabButtons = TABS.map((t) =>
    `    <button class="tab-btn${t.n === 1 ? ' active' : ''}" data-tab="${t.n}">${esc(t.label)}</button>`
  ).join('\n');

  const tab1 = `<div class="field-grid">\n` + fields.map(([label, val]) =>
    `  <div class="field"><div class="label">${esc(label)}</div><div class="value">${esc(val)}</div></div>`
  ).join('\n') + `\n</div>`;

  const contentFor = (t) => {
    if (t.n === 1) return tab1;
    const state = tabState && tabState[t.n];
    // A background stage that throws (bad API key, Gemini outage, network
    // blip) used to leave this tab on "pending" forever -- indistinguishable
    // from "still running" unless you thought to check the log file. 'error'
    // is a third state alongside pending/ready so a real failure is visible
    // where the user is actually looking.
    if (state === 'error') return `<div class="pending error"><div class="pending-icon">⚠️</div><div>השלב הזה נכשל -- בדקו את היומן (logs/trip_app_server.log) ונסו שוב</div></div>`;
    if (state && t.file) return `<iframe class="embed" src="${esc(destination)}${t.file}"></iframe>`;
    return `<div class="pending"><div class="pending-icon">⏳</div><div>שלב זה עדיין לא הופק</div></div>`;
  };

  const main = TABS.map((t) => {
    const full = t.n !== 1 ? ' full-bleed' : '';
    return `    <div class="tab-content${t.n === 1 ? ' active' : ''}${full}" id="tab-${t.n}">
<!-- TAB${t.n}:START -->
${contentFor(t)}
<!-- TAB${t.n}:END -->
    </div>`;
  }).join('\n\n');

  const extraCss = `  :root { --pending:#cdbfa4; }
  body { margin:0; background:var(--paper); color:var(--ink); font-family:'Segoe UI',Arial,sans-serif; direction:rtl; text-align:right; line-height:1.7; }
  header { padding:30px 6vw 20px; border-bottom:1px solid #e2d8c4; }
  header .kicker { font-size:13px; letter-spacing:2px; color:var(--gold); font-weight:700; text-transform:uppercase; margin-bottom:6px; }
  header h1 { margin:0; font-size:36px; }
  nav.tabs { display:flex; gap:4px; padding:0 6vw; background:#f2ece0; border-bottom:1px solid #e2d8c4; overflow-x:auto; }
  nav.tabs button { appearance:none; border:none; background:transparent; padding:16px 20px; font-size:15px; font-weight:600; color:var(--muted); cursor:pointer; border-bottom:3px solid transparent; white-space:nowrap; font-family:inherit; }
  nav.tabs button.active { color:var(--ink); border-bottom-color:var(--accent); }
  nav.tabs button:hover { color:var(--ink); }
  .tab-content { display:none; padding:40px 6vw 60px; max-width:1100px; margin:0 auto; }
  .tab-content.active { display:block; }
  .tab-content.full-bleed { padding:0; max-width:none; margin:0; }
  .pending { text-align:center; padding:100px 6vw; color:var(--muted); }
  .pending .pending-icon { font-size:40px; margin-bottom:16px; opacity:0.5; }
  .pending.error { color:var(--accent); }
  .pending.error .pending-icon { opacity:0.9; }
  .field-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:20px; margin-top:20px; }
  .field { background:#fff; border-radius:10px; padding:16px 18px; box-shadow:0 2px 10px rgba(60,45,25,0.06); }
  .field .label { font-size:12.5px; color:var(--muted); font-weight:700; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
  .field .value { font-size:17px; }
  iframe.embed { width:100%; height:calc(100vh - 150px); border:none; display:block; }`;

  const bodyHtml = `  <header>
    <div class="kicker">KESSLER TRIP</div>
    <h1>${esc(destination)}</h1>
  </header>
  <nav class="tabs">
${tabButtons}
  </nav>
  <main>
${main}
  </main>
  <script>
    document.querySelectorAll('.tab-btn').forEach(function(btn){
      btn.addEventListener('click', function(){
        var n = btn.getAttribute('data-tab');
        document.querySelectorAll('.tab-btn').forEach(function(b){ b.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function(c){ c.classList.remove('active'); });
        btn.classList.add('active');
        document.getElementById('tab-'+n).classList.add('active');
      });
    });

    // Auto-refresh while a background stage is still running -- a real
    // pipeline run finished (Corfu: tabs 3+4 went ready) but the open tab
    // kept showing the stale "pending" state until manually reloaded, since
    // this is a static file with no push mechanism. Self-disabling: does
    // nothing once there's nothing pending (so it's a harmless no-op on an
    // already-finished or already-published trip), and stops polling the
    // moment anything changes rather than polling forever.
    (function(){
      var pendingCount = document.querySelectorAll('.pending:not(.error)').length;
      if (!pendingCount) return;
      var poll = setInterval(function(){
        fetch(location.pathname + '?_poll=' + Date.now(), { cache: 'no-store' })
          .then(function(r){ return r.text(); })
          .then(function(html){
            var doc = new DOMParser().parseFromString(html, 'text/html');
            var stillPending = doc.querySelectorAll('.pending:not(.error)').length;
            if (stillPending !== pendingCount) { clearInterval(poll); location.reload(); }
          })
          .catch(function(){ /* transient fetch error -- just try again next tick */ });
      }, 6000);
    })();
  </script>`;

  return htmlShell(`KESSLER TRIP — ${destination}`, extraCss, bodyHtml);
}

// ---- Showcase (background / reference page) --------------------------------
// Reproduces the ORIGINAL pipeline's Showcase exactly: a hero with a background
// image, a curated tagline, 2-3 background prose paragraphs, then a
// "נקודות מומלצות" grid of image cards with colored category tags. Driven by the
// enrich stage's output (tagline/background/highlights), not the raw plan --
// the earlier version listed every place grouped by region, which is a
// different page; this matches the intended output.
const CAT_TAG = {
  Nature: { he: 'טבע', color: '#27ae60' },
  Urban: { he: 'עיר', color: '#8e44ad' },
  Attraction: { he: 'אטרקציה', color: '#e67e22' },
  Food: { he: 'אוכל', color: '#c0392b' },
  Sleep: { he: 'לינה', color: '#1a1a4e' },
  Other: { he: 'אחר', color: '#6b6157' }
};
function catTag(category) { return CAT_TAG[category] || CAT_TAG.Other; }

// A soft gradient stand-in for a highlight card / hero with no resolved image,
// so the layout never shows a broken <img>.
function gradientFor(seed) {
  const hues = ['#4a3d2e,#2a2320', '#3a4a3e,#20302a', '#4a3e4a,#2a2030', '#4a423a,#302820'];
  return hues[seed % hues.length];
}

function renderShowcase(destination, enrich) {
  const highlights = enrich.highlights || [];
  const heroImg = (highlights.find((h) => h.image) || {}).image || null;
  const heroStyle = heroImg
    ? `background-image: url('${esc(heroImg)}');`
    : `background: linear-gradient(135deg, ${gradientFor(0)});`;

  const backgroundParas = (enrich.background || []).map((p) => `    <p>${esc(p)}</p>`).join('\n');

  const cards = highlights.map((h, i) => {
    const tag = catTag(h.category);
    const img = h.image
      ? `<img src="${esc(h.image)}" alt="${esc(h.name)}">`
      : `<div class="card-img-fallback" style="background:linear-gradient(135deg,${gradientFor(i)})"></div>`;
    return `    <div class="card">
      ${img}
      <div class="card-body">
        <span class="cat-tag" style="background:${tag.color}">${tag.he}</span>
        <h3>${esc(h.name)}</h3>
        <p>${esc(h.showcaseDesc)}</p>
      </div>
    </div>`;
  }).join('\n\n');

  const extraCss = `  body { margin:0; background:var(--paper); color:var(--ink); font-family:'Segoe UI',Arial,sans-serif; direction:rtl; text-align:right; line-height:1.7; }
  .hero { position:relative; height:62vh; min-height:380px; display:flex; align-items:flex-end; background-size:cover; background-position:center; }
  .hero::after { content:''; position:absolute; inset:0; background:linear-gradient(to top, rgba(20,15,10,0.85) 0%, rgba(20,15,10,0.25) 55%, rgba(20,15,10,0.05) 100%); }
  .hero-content { position:relative; z-index:1; padding:40px 6vw 44px; color:#fff; }
  .hero .kicker { font-size:13px; letter-spacing:3px; color:var(--gold); font-weight:700; text-transform:uppercase; margin-bottom:10px; }
  .hero h1 { margin:0 0 10px; font-size:58px; font-weight:800; }
  .hero .tagline { font-size:19px; font-weight:400; max-width:640px; opacity:0.95; }
  .background-section { max-width:760px; margin:0 auto; padding:52px 6vw 20px; }
  .background-section p { font-size:17px; margin-bottom:20px; color:#3a332b; }
  .section-title { max-width:1200px; margin:20px auto 6px; padding:0 6vw; font-size:13px; letter-spacing:2px; text-transform:uppercase; color:var(--gold); font-weight:700; }
  .grid { max-width:1200px; margin:0 auto; padding:10px 6vw 70px; display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:26px; }
  .card { background:#fff; border-radius:14px; overflow:hidden; box-shadow:0 3px 16px rgba(60,45,25,0.09); }
  .card img, .card-img-fallback { width:100%; height:210px; object-fit:cover; display:block; }
  .card-body { padding:18px 20px 22px; }
  .cat-tag { display:inline-block; font-size:11px; font-weight:700; color:#fff; border-radius:4px; padding:2px 9px; margin-bottom:10px; }
  .card h3 { margin:0 0 8px; font-size:19px; }
  .card p { font-size:14.5px; color:var(--muted); margin:0; }
  @media (max-width:480px) { .hero h1 { font-size:34px; } .hero .tagline { font-size:16px; } }`;

  const bodyHtml = `  <div class="hero" style="${heroStyle}">
    <div class="hero-content">
      <div class="kicker">KESSLER TRIP</div>
      <h1>${esc(destination)}</h1>
      <div class="tagline">${esc(enrich.tagline || '')}</div>
    </div>
  </div>

  <div class="background-section">
${backgroundParas}
  </div>

  <div class="section-title">נקודות מומלצות</div>
  <div class="grid">

${cards}

  </div>`;

  return htmlShell(`${destination} — עמוד רקע`, extraCss, bodyHtml);
}

// ---- Sources (Tab 2) -------------------------------------------------------
// A record of the sources used for this trip, in the same cream/gold design
// language. In the live app this is also where the user picks sources before
// mining; here it renders the chosen set.
// Real interactive picker: checkboxes (checked by default -- a discovered
// source already cleared the discovery bar, the user opts specific ones OUT),
// a live count, and a confirm button that POSTs the chosen domains to the
// server so mining only touches what the user actually approved. serverPort
// is injected so this file works against whichever port server.js is running
// on for this machine.
function renderSources(destination, sources, serverPort) {
  const card = (s, i) => {
    const urlCount = (s.urls || []).length;
    return `    <div class="source-card">
      <div class="card-header">
        <input type="checkbox" class="source-check" id="src_${i}" data-domain="${esc(s.domain)}" checked>
        <label for="src_${i}" class="card-title">${esc(s.name || s.domain)}</label>
      </div>
      <div class="card-domain"><a href="https://${esc(s.domain)}" target="_blank" rel="noopener">${esc(s.domain)}</a></div>
      ${s.note ? `<div class="card-desc">${esc(s.note)}</div>` : ''}
      <div class="card-meta">${urlCount} דפים מועמדים לסריקה</div>
    </div>`;
  };

  // Two tiers -- mandatory (the standing Knowledge_Hubs list) always first,
  // then newly-discovered sources for this destination -- each tier grouped
  // by the type of information the source represents, so the page reads the
  // same way regardless of destination instead of one flat grid.
  const indexed = sources.map((s, i) => ({ ...s, _i: i }));
  const tiers = [
    { title: 'מקורות קבועים', items: indexed.filter((s) => s.standing) },
    { title: 'מקורות חדשים שנמצאו ליעד הזה', items: indexed.filter((s) => !s.standing) }
  ].filter((t) => t.items.length);

  const tiersHtml = tiers.map((tier) => {
    const byType = new Map();
    tier.items.forEach((s) => {
      const type = s.type || 'כללי';
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(s);
    });
    const typeGroups = [...byType.entries()].map(([type, items]) => `
    <div class="type-group">
      <div class="type-title">${esc(type)}</div>
      <div class="source-cards">
${items.map((s) => card(s, s._i)).join('\n')}
      </div>
    </div>`).join('\n');
    return `  <div class="tier">
    <h2 class="tier-title">${esc(tier.title)} <span class="tier-count">${tier.items.length}</span></h2>
${typeGroups}
  </div>`;
  }).join('\n');

  const extraCss = `  body { margin:0; background:var(--paper); color:var(--ink); font-family:'Segoe UI',Arial,sans-serif; direction:rtl; text-align:right; line-height:1.6; }
  .container { max-width:1000px; margin:0 auto; padding:40px 6vw; }
  h1 { font-size:30px; margin:0 0 8px; }
  .subtitle { font-size:14px; color:var(--muted); margin-bottom:20px; }
  .toolbar { display:flex; align-items:center; gap:16px; margin-bottom:20px; }
  .toolbar a { cursor:pointer; color:var(--accent); font-size:13px; font-weight:600; }
  .count { font-size:13px; color:var(--muted); }
  .tier { margin-bottom:8px; }
  .tier-title { font-size:20px; margin:28px 0 14px; padding-bottom:8px; border-bottom:2px solid var(--gold); display:flex; align-items:center; gap:10px; }
  .tier-count { font-size:13px; background:var(--gold); color:#fff; border-radius:12px; padding:1px 10px; font-weight:600; }
  .type-group { margin-bottom:22px; }
  .type-title { font-size:13px; letter-spacing:1px; text-transform:uppercase; color:var(--accent); font-weight:700; margin-bottom:10px; }
  .source-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:20px; margin-bottom:12px; }
  .source-card { background:#fff; border-radius:10px; padding:20px; box-shadow:0 2px 10px rgba(60,45,25,0.08); }
  .card-header { display:flex; align-items:center; gap:10px; margin-bottom:6px; }
  .card-header input { width:18px; height:18px; accent-color:var(--accent); cursor:pointer; }
  .card-title { font-weight:700; font-size:17px; cursor:pointer; }
  .card-domain { font-size:13px; margin-bottom:10px; }
  .card-domain a { color:var(--accent); text-decoration:none; font-weight:600; }
  .card-domain a:hover { text-decoration:underline; }
  .card-desc { font-size:14px; color:var(--muted); margin-bottom:10px; }
  .card-meta { font-size:12px; color:var(--muted); border-top:1px solid #e2d8c4; padding-top:10px; }
  .confirm-btn { width:100%; padding:16px; font-size:16px; font-weight:700; background:var(--accent); color:#fff; border:none; border-radius:10px; cursor:pointer; }
  .confirm-btn:hover:not(:disabled) { opacity:0.92; }
  .confirm-btn:disabled { opacity:0.5; cursor:not-allowed; }
  .result-msg { margin-top:14px; font-size:14px; padding:12px 16px; border-radius:8px; display:none; }
  .result-msg.show { display:block; }
  .result-msg.pending { background:#faf6ef; color:var(--muted); border-right:4px solid var(--gold); }
  .result-msg.success { background:#f0f7ed; color:#22863a; border-right:4px solid #22863a; }
  .result-msg.error { background:#fdf0f1; color:var(--accent); border-right:4px solid var(--accent); }
  .spinner { display:inline-block; width:13px; height:13px; border:2px solid rgba(0,0,0,0.15); border-top-color:var(--accent); border-radius:50%; animation:spin .7s linear infinite; vertical-align:-2px; margin-inline-end:7px; }
  @keyframes spin { to { transform:rotate(360deg); } }`;

  const bodyHtml = `  <div class="container">
    <h1>מקורות מחקר — ${esc(destination)}</h1>
    <p class="subtitle">${sources.length} מקורות רלוונטיים נמצאו. הסר מה שלא רוצים לכלול, ולחץ אישור.</p>
    <div class="toolbar">
      <a id="selectAll">בחר הכל</a>
      <a id="clearAll">נקה הכל</a>
      <span class="count" id="countLabel"></span>
    </div>
${tiersHtml}
    <button class="confirm-btn" id="confirmBtn">אישור מקורות והתחלת סריקה</button>
    <div class="result-msg" id="resultMsg"></div>
  </div>
<script>
  const DESTINATION_NAME = ${JSON.stringify(destination)};
  const SERVER_URL = 'http://localhost:${serverPort}/confirm-sources';
  const checks = () => Array.from(document.querySelectorAll('.source-check'));
  function updateCount() {
    document.getElementById('countLabel').textContent = checks().filter(c => c.checked).length + ' מתוך ' + checks().length + ' נבחרו';
  }
  checks().forEach(c => c.addEventListener('change', updateCount));
  document.getElementById('selectAll').addEventListener('click', () => { checks().forEach(c => c.checked = true); updateCount(); });
  document.getElementById('clearAll').addEventListener('click', () => { checks().forEach(c => c.checked = false); updateCount(); });
  updateCount();

  let inFlight = false;
  document.getElementById('confirmBtn').addEventListener('click', async function() {
    if (inFlight) return;
    const domains = checks().filter(c => c.checked).map(c => c.dataset.domain);
    if (!domains.length) { alert('בחר לפחות מקור אחד.'); return; }
    inFlight = true;
    this.disabled = true;
    this.innerHTML = '<span class="spinner"></span>שולח...';
    const msg = document.getElementById('resultMsg');
    msg.className = 'result-msg show pending';
    msg.innerHTML = '<span class="spinner"></span>שולח בחירה לשרת...';
    try {
      const res = await fetch(SERVER_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ destination: DESTINATION_NAME, domains })
      });
      if (res.ok) {
        msg.className = 'result-msg show pending';
        msg.innerHTML = '<span class="spinner"></span>בונה נקודות עניין ומפה... פותח את הדשבורד';
        this.innerHTML = '<span class="spinner"></span>בונה נקודות עניין ומפה...';
        // The dashboard already auto-refreshes itself once tabs 3/4 are
        // ready (see render.js's renderDashboard) -- opening it now instead
        // of waiting here means that polling, not this page, is what tells
        // the user when mining actually finishes.
        setTimeout(() => { window.location.href = '/' + encodeURIComponent(DESTINATION_NAME) + '/' + encodeURIComponent(DESTINATION_NAME) + '_KESSLER_TRIP.html'; }, 900);
      } else {
        msg.className = 'result-msg show error';
        msg.textContent = 'שגיאת שרת: ' + res.status;
        inFlight = false; this.disabled = false; this.textContent = 'אישור מקורות והתחלת סריקה';
      }
    } catch (err) {
      msg.className = 'result-msg show error';
      msg.textContent = 'לא ניתן להתחבר לשרת. ודא/י שהשרת פועל.';
      inFlight = false; this.disabled = false; this.textContent = 'אישור מקורות והתחלת סריקה';
    }
  });
</script>`;

  return htmlShell(`${destination} — מקורות מחקר`, extraCss, bodyHtml);
}

// ---- Final Showcase (Tab 6): the chosen trip, day by day -------------------
function renderFinalShowcase(destination, enrich, itinerary, selection) {
  const byName = {};
  selection.selected.forEach((p) => { byName[p.name] = p; });

  const heroImg = (enrich.highlights || []).find((h) => h.image) || selection.selected.find((p) => p.image);
  const heroStyle = heroImg ? `background-image:url('${esc(heroImg.image)}');` : `background:linear-gradient(135deg,#4a3d2e,#2a2320);`;

  const daysHtml = (itinerary.days || []).map((d) => {
    const cards = (d.route || []).map((name) => {
      const p = byName[name];
      if (!p) return '';
      const tag = catTag(p.category);
      const img = p.image; // guaranteed by attachImagesToPlaces
      const imgHtml = img ? `<img src="${esc(img)}" alt="${esc(name)}">` : '';
      return `      <div class="fs-card">
        ${imgHtml}
        <div class="fs-card-body">
          <span class="cat-tag" style="background:${tag.color}">${tag.he}</span>
          <h3>${esc(name)}</h3>
          <p>${esc(p.description || '')}</p>
        </div>
      </div>`;
    }).join('\n');
    return `  <div class="day-header">
    <div class="day-kicker">${esc(d.dateLabel || ('יום ' + d.day))}</div>
    <h2>${esc(d.title || '')}</h2>
    <div class="day-sub">${esc(d.intro || '')}</div>
    ${d.base ? `<div class="day-base">🛏 לינה הלילה: ${esc(d.base)}</div>` : ''}
  </div>
  <div class="fs-grid">
${cards}
  </div>`;
  }).join('\n');

  const extraCss = `  body { margin:0; background:var(--paper); color:var(--ink); font-family:'Segoe UI',Arial,sans-serif; direction:rtl; text-align:right; line-height:1.7; }
  .hero { position:relative; height:40vh; min-height:260px; display:flex; align-items:flex-end; background-size:cover; background-position:center; }
  .hero::after { content:''; position:absolute; inset:0; background:linear-gradient(to top,rgba(20,15,10,0.85),rgba(20,15,10,0.1)); }
  .hero-content { position:relative; z-index:1; padding:36px 6vw; color:#fff; }
  .hero .kicker { font-size:13px; letter-spacing:3px; color:var(--gold); font-weight:700; text-transform:uppercase; margin-bottom:8px; }
  .hero h1 { margin:0; font-size:44px; font-weight:800; }
  .day-header { max-width:1100px; margin:36px auto 6px; padding:0 6vw; }
  .day-header .day-kicker { font-size:12px; letter-spacing:2px; text-transform:uppercase; color:var(--gold); font-weight:700; }
  .day-header h2 { margin:4px 0 0; font-size:26px; }
  .day-header .day-sub { font-size:14.5px; color:var(--muted); margin-top:4px; }
  .day-header .day-base { font-size:13px; color:var(--gold); font-weight:700; margin-top:8px; }
  .fs-grid { max-width:1100px; margin:0 auto; padding:14px 6vw 10px; display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:20px; }
  .fs-card { background:#fff; border-radius:12px; overflow:hidden; box-shadow:0 2px 12px rgba(60,45,25,0.08); }
  .fs-card img { width:100%; height:160px; object-fit:cover; display:block; }
  .fs-card-body { padding:14px 16px 18px; }
  .cat-tag { display:inline-block; font-size:11px; font-weight:700; color:#fff; border-radius:4px; padding:2px 9px; margin-bottom:8px; }
  .fs-card h3 { margin:0 0 6px; font-size:17px; }
  .fs-card p { font-size:13.5px; color:var(--muted); margin:0; }
  @media (max-width:480px) { .hero h1 { font-size:30px; } }`;

  const bodyHtml = `  <div class="hero" style="${heroStyle}">
    <div class="hero-content">
      <div class="kicker">KESSLER TRIP · המסלול הנבחר</div>
      <h1>${esc(destination)}</h1>
    </div>
  </div>
${daysHtml}
  <div style="height:40px"></div>`;

  return htmlShell(`${destination} — Showcase ממוקד`, extraCss, bodyHtml);
}

// ---- Checklist (Tab 7): what to book ---------------------------------------
// Zero-cost reservation links -- no booking API/key involved, just a
// pre-filled search URL on a real booking site so "order in advance" is one
// click instead of a manual search from scratch.
function googleUrl(q) { return `https://www.google.com/search?q=${encodeURIComponent(q)}`; }
function bookingUrl(q) { return `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(q)}`; }

function renderChecklist(destination, itinerary, selection) {
  // Accommodation is keyed off the itinerary's actual per-night overnight
  // towns (day.base), not off a "Sleep"-category place happening to have been
  // mined -- most destinations never turn up a named hotel from extraction,
  // but the itinerary always knows where each night is spent. One line per
  // UNIQUE town, in the order it's first slept in, with which nights.
  const baseNights = new Map(); // town -> [day numbers]
  (itinerary.days || []).forEach((d) => {
    const town = (d.base || '').trim();
    if (!town) return;
    if (!baseNights.has(town)) baseNights.set(town, []);
    baseNights.get(town).push(d.day);
  });

  const mustBook = selection.selected.filter((p) => p.recommended && p.category === 'Attraction');
  const foods = selection.selected.filter((p) => p.category === 'Food' && p.recommended);

  const section = (title, items, hint, linkFor) => {
    if (!items.length) return '';
    const lis = items.map((p) => `      <li><label><input type="checkbox"> ${esc(p.name)}${p.regionName ? ` <span class="rgn">${esc(p.regionName)}</span>` : ''}</label> <a class="book-link" href="${esc(linkFor(p))}" target="_blank" rel="noopener">🔗 הזמנה</a></li>`).join('\n');
    return `    <section class="cl-section">
      <h2>${esc(title)}</h2>
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ''}
      <ul>
${lis}
      </ul>
    </section>`;
  };

  const bedSection = (() => {
    if (!baseNights.size) return '';
    const lis = [...baseNights.entries()].map(([town, days]) => {
      const nightsLabel = days.length === 1 ? `לילה ${days[0]}` : `לילות ${days.join(', ')}`;
      const link = bookingUrl(`${town}, ${destination}`);
      return `      <li><label><input type="checkbox"> 🛏 ${esc(town)} <span class="rgn">${esc(nightsLabel)}</span></label> <a class="book-link" href="${esc(link)}" target="_blank" rel="noopener">🔗 הזמנה</a></li>`;
    }).join('\n');
    return `    <section class="cl-section">
      <h2>🛏 לינה — להזמין מראש</h2>
      <p class="hint">לפי המסלול, אלו הערים/העיירות שבהן ישנים בפועל — יש להזמין לינה בכל אחת</p>
      <ul>
${lis}
      </ul>
    </section>`;
  })();

  // Basics: flights always apply (this app only plans international trips); a
  // rental car only when the route actually moves between towns -- a
  // single-base trip has no inter-city legs to drive, so "if you need to
  // rent" resolves to "no" and the line is skipped.
  const needsCar = baseNights.size > 1;
  const basicsSection = `    <section class="cl-section">
      <h2>✈️ בסיס — לפני הכל</h2>
      <ul>
        <li><label><input type="checkbox"> טיסות הלוך ושוב</label> <a class="book-link" href="${esc(googleUrl(`טיסות ל${destination}`))}" target="_blank" rel="noopener">🔗 חיפוש טיסות</a></li>
${needsCar ? `        <li><label><input type="checkbox"> רכב שכור (המסלול עובר בין כמה ערים)</label> <a class="book-link" href="${esc(googleUrl(`השכרת רכב ${destination}`))}" target="_blank" rel="noopener">🔗 חיפוש השכרת רכב</a></li>\n` : ''}      </ul>
    </section>`;

  const extraCss = `  body { margin:0; background:var(--paper); color:var(--ink); font-family:'Segoe UI',Arial,sans-serif; direction:rtl; text-align:right; line-height:1.7; }
  .wrap { max-width:820px; margin:0 auto; padding:40px 6vw 60px; }
  h1 { font-size:30px; margin:0 0 6px; }
  .subtitle { color:var(--muted); font-size:14px; margin-bottom:28px; }
  .cl-section { background:#fff; border-radius:12px; padding:20px 24px; margin-bottom:20px; box-shadow:0 2px 10px rgba(60,45,25,0.06); }
  .cl-section h2 { font-size:19px; margin:0 0 4px; color:var(--accent); }
  .cl-section .hint { font-size:13px; color:var(--muted); margin:0 0 12px; }
  .cl-section ul { list-style:none; padding:0; margin:0; }
  .cl-section li { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:6px 12px; padding:7px 0; border-bottom:1px solid #f0e9db; font-size:15px; }
  .cl-section li:last-child { border-bottom:none; }
  .cl-section input { width:18px; height:18px; margin-inline-end:8px; vertical-align:-3px; accent-color:var(--accent); }
  .rgn { font-size:12px; color:var(--muted); }
  .book-link { font-size:12.5px; color:var(--accent); text-decoration:none; white-space:nowrap; }
  .book-link:hover { text-decoration:underline; }`;

  const bodyHtml = `  <div class="wrap">
    <h1>צ'ק-ליסט הזמנות — ${esc(destination)}</h1>
    <p class="subtitle">מה כדאי להזמין מראש לפני הטיול</p>
${basicsSection}
${bedSection}
${section('אטרקציות מומלצות שכדאי להזמין כרטיסים מראש', mustBook, 'מקומות פופולריים — כרטיסים לרוב אוזלים בעונה', (p) => googleUrl(`${p.name} ${destination} כרטיסים`))}
${section('מסעדות מומלצות שכדאי לשריין', foods, 'שולחן מראש במקומות המבוקשים', (p) => googleUrl(`${p.name} ${destination} הזמנת שולחן`))}
  </div>`;

  return htmlShell(`${destination} — צ'ק-ליסט הזמנות`, extraCss, bodyHtml);
}

module.exports = { renderMasterPlanMd, renderDashboard, renderShowcase, renderSources, renderFinalShowcase, renderChecklist, bucketOf, BUCKETS, catTag };
