# KESSLER_TRIP — Pipeline Reference for Claude Code

זהו העתק מלא ועדכני של 5 שלבי הפייפליין (הרצו בהצלחה על סלובניה ומילאנו), כדי שאפשר יהיה להשתמש בהם ב-Claude Code בלי לכתוב מחדש מאפס.

## הקבצים כאן

1. **new-trip-input_SKILL.md** — שלב 1: איסוף פרטי הטיול (או קריאה מ-`New_Trip_Form.html`/`local_server.js` אם כבר מולא), בניית תיקיית היעד ודשבורד ה-HTML.
2. **trip-scan_SKILL.md** — שלב 2: אצירת מקורות מחקר מול `Knowledge_Hubs.md`, כולל הוספת מקורות חדשים.
3. **trip-master-plan_SKILL.md** — שלב 3: כרייה עמוקה של המקורות למסמך מאסטר פלאן (Part A) + בניית המפה האינטראקטיבית עם וויירינג לשרת המקומי (Part B). **זה הקובץ הכי מלא/מעודכן** — כולל את כל הבאגים שנפתרו (async class definition, DistanceMatrixService, dir="rtl" על html/body, פילטר קטגוריות + כפתור "הצע בחירה", fitBounds/outlier-guard בהיילייט אזור). **מכיל דרישה קריטית** שכרייה בפועל = קריאות WebFetch/WebSearch אמיתיות, לא כתיבה מזיכרון כללי — ראה CLAUDE.md → "Critical invariant" לפני כל שינוי בקובץ הזה.
4. **destination-showcase_SKILL.md** — שלב 4: עמוד נחיתה ויזואלי עם תמונות מ-Wikimedia Commons.
5. **final-trip-planner_SKILL.md** — שלב 5 (אחרון): קריאת הבחירה (מ-`<Destination>_Selection.json` או מהצ'אט), בניית מסלול יום-אחר-יום, Showcase ממוקד, וצ'ק-ליסט הזמנות.
6. **kessler_trip_shell_template.html** — תבנית ה-HTML של הדשבורד עם 7 הטאבים, שכל שלב ממלא רק את הטאב שלו.

## הקבצים הפעילים (כבר קיימים בתיקיית Trip Planner הראשית)

- `local_server.js` — השרת המקומי (Node, ללא תלויות). שני endpoints: `/new-trip` ו-`/confirm-selection`. כולל watcher שפותח אוטומטית כל דשבורד חדש (`*_KESSLER_TRIP.html`) בדפדפן ברגע שהוא נוצר.
- `start_local_server.bat` — הפעלת השרת.
- `New_Trip_Form.html` — טופס פתיחת טיול חדש.
- `Knowledge_Hubs.md` — האינדקס הקבוע של מקורות מחקר, גדל עם כל טיול.
- `KESSLER_TRIP_WebApp_Handoff.md` — מסמך רקע מפורט יותר (סכמת DB אפשרית, כל הבאגים ההיסטוריים) — רלוונטי כרקע נוסף גם אם לא בונים web app מלא.
- `LOCAL_TOOLS_README.md` — הסבר שימוש בכלים המקומיים.
- דוגמאות עבודה מלאות: `Slovenia/` ו-`מילאנו/` — כל קובץ שכל שלב מייצר, בפועל.

## אוטומציה מלאה (בנוי)

- `trip_watcher.js` — עוקב אחרי התיקייה ומזהה טיול חדש (`*_Trip_Input.md` בלי דשבורד) או בחירה חדשה/מעודכנת במפה (`*_Selection.json`). מריץ כל שלב כ-**session נפרד** של Claude Code headless (לא session אחד משולב — ראה CLAUDE.md → Architecture להסבר המלא של הרציונל), עם ניתוב מודל לפי שלב (Haiku לשלבים המכניים, מודל ברירת המחדל לשלבים שדורשים שיקול דעת). לוגים בתיקיית `logs/`, עלויות מדודות אמיתיות ב-CLAUDE.md.
- `launch_kessler_trip.js` + `start_kessler_trip.vbs` — הפעלה בלחיצה אחת: מוודא ש-`local_server.js` וה-watcher רצים ברקע (מפעיל אם צריך, בלי חלון קונסולה), ופותח את `New_Trip_Form.html`.
- `setup_desktop_shortcut.ps1` — הרצה חד-פעמית (ידנית, מהמחשב עצמו) שיוצרת קיצור דרך אמיתי בשולחן העבודה שמצביע ל-`start_kessler_trip.vbs`, עם אייקון מותאם (`kess_trip_icon.ico`) ורענון אוטומטי של ה-icon cache.
- `local_server.js` — בנוסף לשני ה-endpoints, פותח מיידית placeholder (`*_KESSLER_TRIP_LOADING.html`) בלחיצת "שליחה" בטופס, כדי שיהיה פידבק ויזואלי מיידי לפני שהדשבורד האמיתי נבנה בפועל.

דורש חד-פעמית, מטרמינל אמיתי (לא דרך צ'אט): `npm install -g @anthropic-ai/claude-code` ואז `claude setup-token` (subscription) או מפתח API ייעודי דרך `.env.local` — ראה CLAUDE.md → Architecture → Auth.

**לפני שינוי כלשהו במערכת, קרא את `../CLAUDE.md`** — הוא מתאר את הארכיטקטורה המלאה, אינוריאנט קריטי אחד (כרייה אמיתית ב-trip-master-plan), עלויות אמיתיות שנמדדו, ורשימת פריטים פתוחים שעדיין לא אומתו.
