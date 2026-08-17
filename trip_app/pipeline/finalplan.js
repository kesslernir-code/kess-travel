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
9. **מקום עם isSleep=true הוא לינה רשמית שהמשתמש כבר בחר/הזמין בפועל (למשל מלון קונקרטי) — לא הצעה.** קבע את ה-base של היום שבו המקום הזה מבוקר בדיוק לשם העיר/עיירה של אותו מקום עצמו, ולא לעיר/עיירה חלופית שנראית הגיונית יותר. בנוסף, מלא את sleepPointName של אותו יום בדיוק בשם המקום עצמו (למשל "Corfu Palace Hotel", לא רק שם העיר) — כדי שהמפה תוכל למקד את מסלול הנסיעה של אותו יום בכתובת המדויקת של הלינה, לא רק במרכז העיר הכללי. אם כמה מקומות מסומנים כך, כל אחד קובע את ה-base וה-sleepPointName של הימים המתאימים לו לפי מיקומו הגיאוגרפי ברצף הימים. ימים שאין להם מקום לינה שסומן ידנית — sleepPointName יישאר ריק/null.
10. **שעות טיסה, אם ניתנו, הן אילוץ נוקשה על היום הראשון והאחרון.** נחיתה בשעת אחר-צהריים מאוחרת/ערב/לילה: היום הראשון כולל רק נסיעה מהשדה לנקודת הלינה (וארוחת ערב קרובה אם הזמן מאפשר), בלי סיורים/אטרקציות — route יכול להיות ריק או לכלול לכל היותר מסעדה סמוכה ללינה. המראה/עזיבה בשעה מוקדמת (לפני הצהריים/צהריים): היום האחרון מצומצם בהתאם — לא לתכנן פעילות שלא תסתיים בזמן להגיע לשדה, ולציין ב-note את שעת היציאה הנדרשת.`;

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
  const prompt = `פרטי הטיול:\n${JSON.stringify(params)}${regionDaysNote}${manualSleepNote}${timingNote}\n\nהמקומות שנבחרו (${selected.length}):\n${JSON.stringify(digest(selected))}`;

  const result = await callGeminiWithRetry(model, prompt, { timeoutMs: TIMEOUT_MS, timeoutLabel: 'Final-plan call' });
  return JSON.parse(result.response.text());
}

module.exports = { buildItinerary, MODEL_NAME };
