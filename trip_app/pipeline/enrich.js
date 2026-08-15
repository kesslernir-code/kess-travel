// Stage: organized plan -> the extra "editorial" data the Showcase + Map need
// that raw extraction doesn't produce: a destination tagline, 2-3 background
// paragraphs, the English destination name + map center + country code (for
// geocoding/region bias), and a curated shortlist of ~12 highlights for the
// showcase grid. ONE bounded Gemini call. Everything it returns is derived from
// the places already mined (it selects/summarizes, it does not invent new
// places), plus general framing prose about the destination itself.

const { getGeminiClient, callGeminiWithRetry } = require('../../lib/geminiClient');

const SYSTEM_INSTRUCTIONS = `אתה עורך תוכן לעמוד רקע של טיול. קלט: שם יעד + רשימת המקומות שכבר נאספו עבורו (מחולקים לאזורים). פלט: מסגור עריכתי לעמוד — לא מקומות חדשים.

חוקים:
1. tagline: משפט אחד קולע (עד 25 מילים) שלוכד את אופי היעד. לא סלוגן פרסומי ריק.
2. background: 2-3 פסקאות פרוזה על היעד עצמו — אופי, אווירה, מה מייחד אותו, איך הוא מתאים לטיול. פרוזה זורמת, לא רשימה. מבוסס על ידע כללי סביר על היעד + מה שעולה מהמקומות שנאספו.
3. highlights: בחר עד 12 מהמקומות הבולטים/מומלצים ביותר מהרשימה שקיבלת (רק מקומות שמופיעים בקלט — אל תמציא). לכל אחד: name (בדיוק כפי שמופיע בקלט), showcaseDesc (2-3 משפטים מלוטשים לכרטיס בעמוד הרקע), category (העתק מהקלט), ו-imageQuery (מונח חיפוש באנגלית לתמונה של המקום, למשל "Narikala Fortress Tbilisi").
4. destinationEn: שם היעד באנגלית. countryCode: קוד ISO של המדינה (למשל GE). mapCenter: קואורדינטות מרכזיות משוערות של היעד {lat,lng}.
5. mainCityName: שם העיר הראשית/עיר הבסיס לטיול בעברית (למשל "טביליסי"). mainCityEn: אותה עיר באנגלית (למשל "Tbilisi") — זו נקודת הייחוס שממנה מודדים מרחקי נסיעה לאזורים. mainCityCenter: קואורדינטות מרכז העיר הראשית {lat,lng} (למשל טביליסי ≈ 41.7,44.8) — סביבה מצויר עיגול של כשעת נסיעה.
6. אל תמציא עובדות על מקומות ספציפיים מעבר למה שהיה בקלט; לגבי מסגור כללי של היעד מותר ידע כללי.`;

const ENRICH_SCHEMA = {
  type: 'object',
  properties: {
    destinationEn: { type: 'string' },
    countryCode: { type: 'string' },
    mainCityName: { type: 'string' },
    mainCityEn: { type: 'string' },
    mainCityCenter: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] },
    mapCenter: { type: 'object', properties: { lat: { type: 'number' }, lng: { type: 'number' } }, required: ['lat', 'lng'] },
    tagline: { type: 'string' },
    background: { type: 'array', items: { type: 'string' } },
    highlights: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          showcaseDesc: { type: 'string' },
          category: { type: 'string', enum: ['Nature', 'Urban', 'Attraction', 'Food', 'Sleep', 'Other'] },
          imageQuery: { type: 'string' }
        },
        required: ['name', 'showcaseDesc', 'category', 'imageQuery']
      }
    }
  },
  required: ['destinationEn', 'countryCode', 'mainCityName', 'mainCityEn', 'mainCityCenter', 'mapCenter', 'tagline', 'background', 'highlights']
};

const MODEL_NAME = 'gemini-flash-latest';
const ENRICH_TIMEOUT_MS = 120000;

function planDigest(plan) {
  return plan.regions.map((r) => ({
    region: r.name,
    places: r.places.map((p) => ({ name: p.name, description: p.description, category: p.category, recommended: !!p.recommended }))
  }));
}

async function enrichPlan(plan, destination) {
  const model = getGeminiClient().getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_INSTRUCTIONS,
    generationConfig: { responseMimeType: 'application/json', responseSchema: ENRICH_SCHEMA }
  });
  const prompt = `יעד: ${destination}\n\nהמקומות שנאספו (JSON):\n${JSON.stringify(planDigest(plan))}`;

  const result = await callGeminiWithRetry(model, prompt, { timeoutMs: ENRICH_TIMEOUT_MS, timeoutLabel: 'Enrich call' });
  return JSON.parse(result.response.text());
}

module.exports = { enrichPlan, MODEL_NAME };
