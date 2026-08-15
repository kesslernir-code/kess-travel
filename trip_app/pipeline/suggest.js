// Server-side mirror of the map's "💡 הצע בחירה" button, so the test can use
// the same kind of selection a user would get from clicking suggest -- without
// driving the browser. The client version fills days by geocoded distance; here
// we don't have coordinates server-side, so region grouping stands in for
// proximity (same-region-first), which is the dominant factor in the original
// anyway. Same shape: recommended-seeded days, category-mixed, one sleep per
// used region.

// Canonical implementation -- rendermaps.js injects THIS EXACT function
// (via .toString()) into route_map.template.html's client-side JS, so the
// server-side "suggest" mirror used by test_full.js and the real button a
// user clicks in the browser can never drift into different numbers again
// (a real bug: this used to say 6/4/5 here but 5/3/4 in the template).
function pointsPerDayFromPace(pace) {
  const s = (pace || '').toString();
  if (/רגוע|משפחתי|קל/.test(s)) return 3;
  if (/עמוס|אינטנסיבי|הרבה/.test(s)) return 5;
  return 4;
}

// Flatten plan -> places tagged with their region name.
function flatten(plan) {
  const out = [];
  for (const r of plan.regions) for (const p of r.places) out.push({ ...p, regionName: r.name });
  return out;
}

function suggestSelection(plan, input) {
  const days = Number(input.days) || 3;
  const perDay = pointsPerDayFromPace(input.pace || '');
  const all = flatten(plan);
  const nonSleep = all.filter((p) => p.category !== 'Sleep');
  const recommended = nonSleep.filter((p) => p.recommended);

  const used = new Set();
  const seededRegions = new Set();
  const key = (p) => `${p.regionName}|${p.name}`;

  function pickSeed() {
    let pool = recommended.filter((p) => !used.has(key(p)) && !seededRegions.has(p.regionName));
    if (!pool.length) pool = recommended.filter((p) => !used.has(key(p)));
    if (!pool.length) pool = nonSleep.filter((p) => !used.has(key(p)) && !seededRegions.has(p.regionName));
    if (!pool.length) pool = nonSleep.filter((p) => !used.has(key(p)));
    return pool[0] || null;
  }

  for (let day = 1; day <= days; day++) {
    const seed = pickSeed();
    if (!seed) break;
    seededRegions.add(seed.regionName);
    used.add(key(seed));
    const dayPoints = [seed];
    while (dayPoints.length < perDay) {
      const sameRegion = nonSleep.filter((p) => !used.has(key(p)) && p.regionName === seed.regionName);
      const pool = sameRegion.length ? sameRegion : nonSleep.filter((p) => !used.has(key(p)));
      if (!pool.length) break;
      // Least-represented category in this day first (mix), then recommended first.
      const catCounts = {};
      dayPoints.forEach((p) => { catCounts[p.category] = (catCounts[p.category] || 0) + 1; });
      pool.sort((a, b) => {
        const ca = catCounts[a.category] || 0, cb = catCounts[b.category] || 0;
        if (ca !== cb) return ca - cb;
        return (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0);
      });
      dayPoints.push(pool[0]);
      used.add(key(pool[0]));
    }
  }

  // One sleep point per used region.
  const usedRegions = new Set(all.filter((p) => used.has(key(p))).map((p) => p.regionName));
  for (const regionName of usedRegions) {
    const sleep = all.find((p) => p.regionName === regionName && p.category === 'Sleep' && !used.has(key(p)));
    if (sleep) used.add(key(sleep));
  }

  const selected = all.filter((p) => used.has(key(p)));
  return { selected, perDay, days, usedRegions: [...usedRegions] };
}

module.exports = { suggestSelection, pointsPerDayFromPace };
