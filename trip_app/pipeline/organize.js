// Stage: extracted points -> organized Master Plan (region + category).
//
// This is the ONE place in the whole app, besides extraction itself, that
// needs a brain -- and it's a single, bounded, structured Gemini call, not an
// open-ended agent. It takes the flat list of places the miner produced across
// all sources and does two things a human would: (1) merges near-duplicate
// places that several sources each mention (keeping every source as an
// attribution), and (2) groups the unique places into named geographic regions.
// Category (Nature/Urban/Attraction/Other) already comes from extraction; this
// only adds the region axis and the dedup.
//
// Everything downstream of this (the Master Plan text, the map, the showcase)
// is pure templating over this call's structured output -- no further LLM.

const { getGeminiClient, callGeminiWithRetry } = require('../../lib/geminiClient');

const SYSTEM_INSTRUCTIONS = `אתה מארגן מאגר נקודות עניין לטיול, לא כותב תוכן חדש. קלט: רשימה שטוחה של מקומות שחולצו מכמה מקורות שונים, לכל אחד שם, תיאור, קטגוריה, ומקור. תפקידך לארגן אותה — לא להוסיף, לא להמציא, לא להרחיב.

חוקים מחייבים:
1. איחוד כפילויות: אם אותו מקום ממש מופיע כמה פעמים (אותו מקום פיזי, גם אם השם מנוסח מעט שונה — "מבצר נריקלה" מול "Narikala Fortress"), אחד אותם לפריט אחד. שמור את התיאור העשיר ביותר מבין הכפילויות, וצרף את כל שמות המקורות שהזכירו אותו למערך sources.
2. חלוקה לאזורים גיאוגרפיים: קבץ את המקומות לאזורים בעלי שם (למשל "טביליסי", "קזבגי והרי הקווקז", "קחתיה — אזור היין"). קבע את האזור לפי מה שהטקסט והמיקומים מרמזים; אל תמציא אזור אם באמת לא ברור — במקרה כזה שים ב"אחר / כללי".
3. אל תשנה תיאורים מהותית. מותר לקצר קלות לניסוח אחיד, אסור להוסיף עובדות שלא היו בקלט.
4. שמור על הקטגוריה שהגיעה בקלט לכל מקום (Nature/Urban/Attraction/Food/Sleep/Other).
5. החזר כל מקום פעם אחת בלבד, תחת אזור אחד בלבד.
6. סדר את האזורים כך שהמרכזי/הגדול ביותר לטיול מופיע ראשון (בדרך כלל עיר הבסיס), והשאר אחריו.`;

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    regions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          places: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                category: {
                  type: 'string',
                  enum: ['Nature', 'Urban', 'Attraction', 'Food', 'Sleep', 'Other']
                },
                recommended: { type: 'boolean' },
                coordinates: {
                  type: 'object',
                  nullable: true,
                  properties: { lat: { type: 'number' }, lng: { type: 'number' } }
                },
                sources: { type: 'array', items: { type: 'string' } }
              },
              required: ['name', 'description', 'category', 'sources']
            }
          }
        },
        required: ['name', 'places']
      }
    }
  },
  required: ['regions']
};

const MODEL_NAME = 'gemini-flash-latest';
const ORGANIZE_TIMEOUT_MS = 120000; // one big call over the whole point set; give it room

// Feed the model a compact view of each point -- it does not need the full
// long description to decide region/dedup, and trimming keeps the single call
// well within limits even for a large multi-source point set.
function toModelInput(points) {
  return points.map((p, i) => ({
    i,
    name: p.name,
    description: p.description_long || p.description || '',
    category: p.category,
    recommended: !!p.recommended,
    location: p.location_mentioned || null,
    coordinates: p.coordinates || null,
    source: p.source_domain || p.source_url || 'unknown'
  }));
}

async function organizePoints(points, destination) {
  if (!points || points.length === 0) {
    return { destination, regions: [] };
  }
  const model = getGeminiClient().getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_INSTRUCTIONS,
    generationConfig: { responseMimeType: 'application/json', responseSchema: PLAN_SCHEMA }
  });

  const prompt = `יעד הטיול: ${destination}\nמספר נקודות בקלט: ${points.length}\n\nרשימת הנקודות (JSON):\n${JSON.stringify(toModelInput(points))}`;

  const result = await callGeminiWithRetry(model, prompt, { timeoutMs: ORGANIZE_TIMEOUT_MS, timeoutLabel: 'Organize call' });

  const parsed = JSON.parse(result.response.text());
  return { destination, regions: parsed.regions || [] };
}

module.exports = { organizePoints, MODEL_NAME };
