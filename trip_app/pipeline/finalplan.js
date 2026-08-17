// Stage: selected points + trip params -> a day-by-day itinerary (the DAYS
// structure the Final_Map / Final_Showcase / Checklist templates expect). ONE
// Gemini call. It sequences the chosen places into days, each geographically
// coherent, ordered sensibly, with a Hebrew intro and a day title -- the same
// judgment the old Stage B "final trip planner" did, as a single structured
// call instead of a claude -p session.

const { getGeminiClient, callGeminiWithRetry } = require('../../lib/geminiClient');

const SYSTEM_INSTRUCTIONS = `אתה מתכנן מסלול טיול יומי מותאם אישית. קלט: רשימת מקומות שנבחרו (עם אזור, קטגוריה, ודגל recommended), ופרטי הטיול מהטופס (מספר ימים, תאריכים, התניידות, קצב, מספר משתתפים, הרכב המשתתפים, דגשים מיוחדים, עיר בסיס). פלט: מסלול יומי מותאם.

חוקים:
1. חלק את המקומות ל-N ימים (N = מספר הימים בקלט). כל יום קוהרנטי גיאוגרפית — מקומות מאותו אזור/קרובים באותו יום, לא לקפוץ בין קצוות המדינה באותו יום. **אם ניתן "מספר ימים שנקבע ידנית לכל אזור" בקלט — זו הגבלה מחייבת, לא המלצה: הקצה בדיוק את מספר הימים שצוין לכל אזור (למשל אם נקבע 2 ימים לאזור X, בדיוק 2 מהימים הכוללים יוקדשו לאזור הזה), וסדר את הימים כך שאזורים גיאוגרפית סמוכים יבואו ברצף.**
2. **התאם אישית לפרטי הטופס:** אם יש ילדים בהרכב — העדף מקומות מתאימים למשפחות והימנע ממקומות תובעניים מדי; לפי הדגשים המיוחדים — תעדף מקומות שתואמים אותם (אוכל/טבע/היסטוריה וכו'); לפי ההתניידות — אם אין רכב, שמור על מקומות נגישים בתחבורה, אם יש רכב אפשר טיולי יום רחוקים יותר.
3. **מקומות recommended הם בעדיפות** — שבץ אותם קודם ופזר אותם על פני הימים כך שכל יום כולל לפחות נקודת שיא אחת. מקום שלא recommended ולא מתאים לדגשים — אפשר להשמיט אם היום מתמלא.
4. **אל תעמיס ימים.** קצב "רגוע" = עד ~3-4 פעילויות ביום; קצב רגיל = ~4-5; אינטנסיבי = ~5-6. פחות עדיף על יותר. חשב זמני נסיעה — יום עם נסיעה ארוכה בין אזורים מקבל פחות פעילויות. הטיול צריך להיות מציאותי ובר-ביצוע, לא רשימת מכולת דחוסה.
5. סדר את המקומות בתוך כל יום בסדר הגיוני לביקור (לפי קרבה/רצף).
6. לכל יום: title (שם/נושא היום), intro (2-3 משפטים בעברית שמתארים את חווית היום, אפשר אימוג'י), route (מערך שמות המקומות — בדיוק כפי שהופיעו בקלט), ו-note אופציונלי (אזהרה/טיפ, למשל "יום עם נסיעה ארוכה" או "מתאים לילדים").
7. מקומות מקטגוריית Food ביום — כלול ב-route וגם ב-restaurants (מערך שמות).
8. **base לכל יום בנפרד — זו נקודת הלינה של אותו לילה הספציפי, לא בסיס אחיד לכל הטיול.** בטיול שנשאר באותה עיר לאורך כמה ימים, ה-base יחזור על עצמו. בטיול מתגלגל (רכב, כמה ערים) — ה-base של יום N הוא בעיר/אזור שהכי הגיוני ללון בו באותו לילה בהתחשב באיפה נמצאים באותו יום ולאן ממשיכים למחרת; אל תשאיר את כולם על אותה עיר-בסיס אם הטיול בפועל מתקדם גיאוגרפית. base הוא תמיד שם עיר/עיירה אמיתי (מהקלט או ידע כללי על האזור), לא שם של אתר/אטרקציה. אל תמציא מקומות שלא בקלט לגבי ה-route עצמו. dateLabel: תאריך קונקרטי אם ניתן לגזור מהקלט, אחרת "יום N".
8א. **אם ניתנה רשימת "בסיסי לינה מותרים" (sleepBaseCandidates) בקלט — זו הגבלה מחייבת, לא המלצה.** ה-base של כל יום חייב להיות בדיוק אחד מהערכים ברשימה הזו (לפי איזה אזור רלוונטי לאותו יום ברצף המסלול). לעולם אל תבחר בעיר הראשית הכללית של היעד (baseCity) כ-base של לילה, אלא אם היא עצמה מופיעה כאחד מבסיסי הלינה המותרים ברשימה. אזור שאינו ברשימת בסיסי הלינה (למשל כי סומן ב-0 ימים באילוץ מספר הימים לאזור) אינו יכול לשמש בסיס לינה בשום יום, גם אם מבקרים בו במהלך היום.
9. **מקום עם isSleep=true הוא לינה רשמית שהמשתמש כבר בחר/הזמין בפועל (למשל מלון קונקרטי) — לא הצעה.** קבע את ה-base של היום שבו המקום הזה מבוקר בדיוק לשם העיר/עיירה של אותו מקום עצמו, ולא לעיר/עיירה חלופית שנראית הגיונית יותר. בנוסף, מלא את sleepPointName של אותו יום בדיוק בשם המקום עצמו (למשל "Corfu Palace Hotel", לא רק שם העיר) — כדי שהמפה תוכל למקד את מסלול הנסיעה של אותו יום בכתובת המדויקת של הלינה, לא רק במרכז העיר הכללי. אם כמה מקומות מסומנים כך, כל אחד קובע את ה-base וה-sleepPointName של הימים המתאימים לו לפי מיקומו הגיאוגרפי ברצף הימים. ימים שאין להם מקום לינה שסומן ידנית — sleepPointName יישאר ריק/null.
10. **שעות טיסה, אם ניתנו, הן אילוץ נוקשה על היום הראשון והאחרון.** נחיתה בשעת אחר-צהריים מאוחרת/ערב/לילה: היום הראשון כולל רק נסיעה מהשדה לנקודת הלינה (וארוחת ערב קרובה אם הזמן מאפשר), בלי סיורים/אטרקציות — route יכול להיות ריק או לכלול לכל היותר מסעדה סמוכה ללינה. המראה/עזיבה בשעה מוקדמת (לפני הצהריים/צהריים): היום האחרון מצומצם בהתאם — לא לתכנן פעילות שלא תסתיים בזמן להגיע לשדה, ולציין ב-note את שעת היציאה הנדרשת.
11. **רצף גיאוגרפי וימי הגעה/עזיבה:** (א) ברגע שעוזבים אזור, אל תחזרו אליו בימים מאוחרים יותר שאינם סמוכים — אשכול הימים של כל אזור צריך להיות רצוף, לא מפוזר. (ב) אם arrivalIsLate=true (ראה סיווג מחושב מראש בקלט) — היום הראשון הוא נסיעה בלבד מהעיר הראשית/נמל התעופה אל בסיס הלינה של אותו לילה, route ריק או לכל היותר מסעדה סמוכה לבסיס. אם arrivalIsLate=false — העדף ליום הראשון מקומות מאזור שנמצא, ככל הניתן משמות האזורים, בדרך הגיאוגרפית בין העיר הראשית לבין אזור בסיס הלינה של הלילה הראשון. אם arrivalIsLate הוא null — הפעל שיקול דעת לפי הטקסט החופשי של שעת הנחיתה. (ג) אם אזור העיר הראשית/נמל התעופה סומן ב-0 ימים ולא שובץ בשום יום אחר — שבץ את המקומות שנבחרו בו ביום האחרון, בכפוף לאילוץ שעת ההמראה (חוק 10), במקום לדלג עליו לגמרי או לבזבז עליו יום מוקדם יותר.`;

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    base: { type: 'string' }, // trip's overall starting base -- kept for backward compat / single-base trips
    days: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'number' },
          dateLabel: { type: 'string' },
          title: { type: 'string' },
          intro: { type: 'string' },
          route: { type: 'array', items: { type: 'string' } },
          restaurants: { type: 'array', items: { type: 'string' } },
          base: { type: 'string' }, // THIS night's actual overnight town -- can differ day to day
          sleepPointName: { type: 'string', nullable: true }, // exact name of the manually-designated isSleep point covering this night, if any -- lets the map route to that precise address instead of just the town center
          note: { type: 'string', nullable: true }
        },
        required: ['day', 'dateLabel', 'title', 'intro', 'route', 'base']
      }
    }
  },
  required: ['base', 'days']
};

const MODEL_NAME = 'gemini-flash-latest';
const TIMEOUT_MS = 120000;

function digest(selected) {
  return selected.map((p) => ({ name: p.name, region: p.regionName, category: p.category, recommended: !!p.recommended, isSleep: !!p.isSleep }));
}

// A region with regionDays[region] > 0 is a real sleep base for that many
// nights; 0 or unset means visit-only and contributes no base candidate at
// all -- this is what was missing before: nothing ever told the AI "here is
// where you're actually allowed to sleep," so it free-associated back to the
// destination's general main city every night regardless of what regionDays
// said (a real, confirmed bug: a region marked 0 days still showed up as
// every single night's base). If a manual isSleep point exists in that
// region, its exact name is the candidate (so the map can geocode the
// precise address); otherwise the region's own display name is the literal
// fallback base name.
function deriveSleepBaseCandidates(selected, regionDays) {
  if (!regionDays) return null;
  const candidates = {};
  Object.keys(regionDays).forEach((region) => {
    const days = regionDays[region];
    if (!days || days <= 0) return;
    const sleepPoint = selected.find((p) => p.regionName === region && p.isSleep);
    candidates[region] = sleepPoint ? sleepPoint.name : region;
  });
  return Object.keys(candidates).length ? candidates : null;
}

// Regex-first HH:mm extraction from free text like "20:00 בערב", falling back
// to Hebrew day-part keywords. Returns null (not a guess) when neither
// matches, so the prompt rule can fall back to the AI's own reading of the
// raw text instead of being steered by a wrong forced boolean.
function parseHourFromTimeString(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2}):(\d{2})/);
  if (m) return Number(m[1]);
  const KEYWORDS = [[/בוקר/, 9], [/צהריים/, 13], [/אחה"?צ|אחר\s*הצהריים/, 16], [/ערב/, 19], [/לילה/, 22]];
  for (const [re, h] of KEYWORDS) if (re.test(s)) return h;
  return null;
}
function isLateArrival(t) { const h = parseHourFromTimeString(t); return h === null ? null : h >= 16; }
function isEarlyDeparture(t) { const h = parseHourFromTimeString(t); return h === null ? null : h <= 12; }

async function buildItinerary(selected, input, enrich, regionDays) {
  const model = getGeminiClient().getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_INSTRUCTIONS,
    generationConfig: { responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA }
  });
  const params = {
    days: input.days, dates: input.dates, transport: input.transport, pace: input.pace,
    participants: input.participants, composition: input.composition,
    arrivalTime: input.arrivalTime || null, departureTime: input.departureTime || null,
    baseCity: (enrich && enrich.mainCityName) || input.destination
  };
  // regionDays comes straight from the user's own per-region dropdown on the
  // map (Tab 4) -- a real constraint to honor, not a suggestion to weigh
  // against other factors. Only pass through regions that were actually set.
  const regionDaysNote = regionDays && Object.keys(regionDays).length
    ? `\n\nמספר ימים שנקבע ידנית לכל אזור (חובה לכבד במדויק -- סך הימים בכל האזורים אמור להתאים למספר הימים הכולל של הטיול):\n${JSON.stringify(regionDays)}`
    : '';
  // Explicit call-out, same reasoning as regionDaysNote above: a constraint
  // embedded only as one field per place in a long list is easy to miss --
  // naming it separately makes it much more likely to actually be honored.
  const manualSleepNames = selected.filter((p) => p.isSleep).map((p) => p.name);
  const manualSleepNote = manualSleepNames.length
    ? `\n\nמקומות שהמשתמש סימן במפורש כלינה רשמית שכבר הוזמנה בפועל (base של היום המתאים חייב להיות העיר/עיירה של המקום הזה עצמו, ו-sleepPointName של אותו יום חייב להיות בדיוק שם המקום עצמו -- לא הצעה חלופית):\n${JSON.stringify(manualSleepNames)}`
    : '';
  // Same reasoning again: this was previously only buried inside "emphases"
  // free text (e.g. "מגיעים בערב, ביום האחרון טסים ב-17:00") and got missed --
  // a real run's day 1 came back with a full sightseeing day despite an
  // evening arrival. Naming it as its own constraint, not prose to parse.
  const timingNote = (input.arrivalTime || input.departureTime)
    ? `\n\nשעות טיסה (ראה חוק 10 -- אילוץ נוקשה, לא המלצה):\n${JSON.stringify({ arrivalTime: input.arrivalTime || null, departureTime: input.departureTime || null })}`
    : '';
  // Same reasoning again, and the direct fix for the base-defaulting bug:
  // computed server-side (not left for the AI to infer) so it's a hard
  // constraint the AI can't drift away from.
  const sleepBaseCandidates = deriveSleepBaseCandidates(selected, regionDays);
  const sleepBaseNote = sleepBaseCandidates
    ? `\n\nבסיסי הלינה המותרים ללילה, לפי אזור (ראה חוק 8א -- אילוץ מחייב):\n${JSON.stringify(sleepBaseCandidates)}`
    : '';
  const arrivalIsLate = isLateArrival(input.arrivalTime);
  const departureIsEarly = isEarlyDeparture(input.departureTime);
  const timingFlagsNote = (arrivalIsLate !== null || departureIsEarly !== null)
    ? `\n\nסיווג מחושב מראש של שעות הטיסה (עקוב אחריו; אם ערך הוא null, הפעל שיקול דעת לפי הטקסט החופשי למעלה):\n${JSON.stringify({ arrivalIsLate, departureIsEarly })}`
    : '';
  const prompt = `פרטי הטיול:\n${JSON.stringify(params)}${regionDaysNote}${manualSleepNote}${timingNote}${sleepBaseNote}${timingFlagsNote}\n\nהמקומות שנבחרו (${selected.length}):\n${JSON.stringify(digest(selected))}`;

  const result = await callGeminiWithRetry(model, prompt, { timeoutMs: TIMEOUT_MS, timeoutLabel: 'Final-plan call' });
  return JSON.parse(result.response.text());
}

module.exports = { buildItinerary, MODEL_NAME, deriveSleepBaseCandidates, parseHourFromTimeString, isLateArrival, isEarlyDeparture };
