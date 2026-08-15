// Stage B (part 2) of the Gemini-based mining pipeline: clean text -> a
// structured list of points of interest. Replaces the extraction+judgment
// work Claude subagents used to do on raw fetched HTML -- that's where
// today's real failures came from (async-dispatch thrashing, a model that
// couldn't reliably apply a written call-cap formula, and mining that simply
// costs more than a few dollars in Claude tokens once you multiply subagents
// x domains x rounds). Gemini 1.5 Flash is roughly two orders of magnitude
// cheaper per token and has a genuinely free tier that likely covers this
// project's actual volume outright.
//
// Deliberately narrow: this file's only job is "text in, structured points
// out." It does not judge which points matter, does not dedupe across
// sources, does not organize by region -- that's Stage C's job, done by
// Claude afterward on the already-clean JSON this produces (cheap, since
// there's no web fetching left to do by that point).

const { getGeminiClient, callGeminiWithRetry } = require('./geminiClient');

const SYSTEM_INSTRUCTIONS = `אתה מנוע חילוץ מידע גיאוגרפי-תיירותי, לא כותב תוכן ולא ממליץ. תפקידך היחיד: לקרוא טקסט גולמי שמקורו בעמוד אינטרנט של אתר תוכן טיולים, ולחלץ ממנו את כל נקודות העניין הקונקרטיות המוזכרות בו בפועל — מקומות, אטרקציות, טרקים, מסעדות, פעילויות בשם ספציפי.

חוקים מחייבים:
1. חלץ רק פריטים בשם ספציפי וניתן-לזיהוי ("אגם קורולדי", "מבצר נריקלה") — לא קטגוריות כלליות ("מקומות יפים באזור").
2. אל תמציא שום פרט. אם מיקום, קואורדינטות או תיאור לא מופיעים בטקסט בפועל — השאר null. לעולם אל תשלים מידע מהידע הכללי שלך על היעד.
3. שני תיאורים לכל פריט, שני אורכים שונים בכוונה לשני צרכנים שונים במערכת:
   - description: עד 20 מילים, עובדה או ייחוד אחד בולט — מתאים להופיע כטקסט בבועת מפה, לא סלוגן שיווקי.
   - description_long: 2-4 משפטים מלאים, כל מה שהטקסט בפועל אומר על הפריט הזה (למה הוא מיוחד, מה יש לעשות בו, פרטים קונקרטיים) — זה מה שמוזן למסמך התכנון הראשי, ולכן חשוב שיהיה עשיר ומפורט ולא רק חזרה על ה-description הקצר. אם המקור נותן רק משפט אחד קצר על הפריט, אל תמציא תוכן נוסף כדי להגיע ל-2-4 משפטים — תיאור קצר אמיתי טוב יותר מתיאור מומצא ארוך.
4. location_mentioned וcoordinates: רק אם מוזכרים במפורש בטקסט (שם עיר/אזור סמוך, או קואורדינטות מספריות). אחרת null.
5. category: אחת מ- Nature / Urban / Attraction / Food / Sleep / Other.
6. recommended=true רק אם המקור עצמו מתאר את הפריט כ"חובה לראות" / "המומלץ ביותר" / מקדיש לו תשומת לב חריגה בהשוואה לשאר.
7. התעלם מפרסומות, תפריטי ניווט, תגובות גולשים ותוכן שאינו נקודת עניין קונקרטית.
8. החזר רשימה מקיפה ומלאה של כל מה שהטקסט מכיל — אל תסנן ואל תקצר; הסינון האיכותי קורה בשלב הבא במערכת, לא כאן.`;

const POINTS_SCHEMA = {
  type: 'object',
  properties: {
    points: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          description_long: { type: 'string' },
          category: {
            type: 'string',
            enum: ['Nature', 'Urban', 'Attraction', 'Food', 'Sleep', 'Other']
          },
          recommended: { type: 'boolean' },
          location_mentioned: { type: 'string', nullable: true },
          coordinates: {
            type: 'object',
            nullable: true,
            properties: {
              lat: { type: 'number' },
              lng: { type: 'number' }
            }
          }
        },
        required: ['name', 'description', 'description_long', 'category', 'recommended']
      }
    }
  },
  required: ['points']
};

// gemini-1.5-flash was fully retired (returns 404) by the time this was
// wired up -- confirmed via a live ListModels call against this API key.
// Using the "-latest" alias instead of pinning a dated model string on
// purpose: Google renames/retires Flash-tier models over time (that's
// exactly what just happened), and this alias always resolves to their
// current recommended stable Flash model without needing this file edited
// again every time that happens.
const MODEL_NAME = 'gemini-flash-latest';
// 45s was too tight for a real test (a large page's comprehensive extraction
// took longer and timed out) -- raised alongside scrape.js's new 50K-char
// input cap, which bounds the pathological case; this gives normal-sized
// pages real headroom too.
const EXTRACT_TIMEOUT_MS = 90000;

async function extractPoints(cleanText, destination, sourceUrl) {
  const model = getGeminiClient().getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_INSTRUCTIONS,
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: POINTS_SCHEMA
    }
  });

  const prompt = `יעד הטיול: ${destination}\nכתובת המקור: ${sourceUrl}\n\nתוכן העמוד (טקסט נקי):\n${cleanText}`;

  const result = await callGeminiWithRetry(model, prompt, { timeoutMs: EXTRACT_TIMEOUT_MS, timeoutLabel: `Gemini extraction for ${sourceUrl}` });

  const parsed = JSON.parse(result.response.text());
  const points = parsed.points || [];
  // Stamp the source URL onto every point -- Stage C needs this for
  // attribution and for cross-referencing back to Sources.md's coverage
  // notes; Gemini itself doesn't need to think about it.
  return points.map((p) => ({ ...p, source_url: sourceUrl }));
}

module.exports = { extractPoints, MODEL_NAME };
