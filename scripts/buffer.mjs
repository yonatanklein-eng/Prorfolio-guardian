// The portfolio rules with a band around the 200-day line: a close counts as
// below only when it is more than b under the line, and as above only when it
// is more than b over it; a close inside the band breaks either streak.
// Stock sleeve only; out of stocks, the money earns the 3-month T-bill rate
// (or nothing, for comparison).
const key = process.env.FRED_API_KEY;
async function fred(id, start) {
  const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&observation_start=${start}`);
  return (await r.json()).observations.map(o => ({ date: o.date, v: parseFloat(o.value) })).filter(o => isFinite(o.v));
}
const sp = await fred('SP500', '2016-01-01');
const tb = await fred('DTB3', '2016-01-01');
const tbBy = new Map(tb.map(o => [o.date, o.v]));
const closes = sp.map(o => o.v), dates = sp.map(o => o.date);
// Friday 20.11 is not on FRED yet: SPY's close times the index/ETF ratio.
closes.push(6914.6); dates.push('2026-11-20 (est.)');
let lastTb = tb[0].v; const cashRate = dates.map(d => { if (tbBy.has(d)) lastTb = tbBy.get(d); return lastTb; });
console.log(`S&P closes ${closes.length}: ${dates[0]} .. ${dates.at(-1)}; T-bill now ${lastTb}%`);

const avg = (a, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
function rules(b) {
  let held = 3, below = 0, above = 0; const ev = [];
  for (let i = 0; i < closes.length; i++) {
    const s200 = avg(closes, i, 200); if (s200 == null) continue; const s50 = avg(closes, i, 50);
    if (closes[i] < s200 * (1 - b)) { below++; above = 0; }
    else if (closes[i] > s200 * (1 + b)) { above++; below = 0; }
    else { below = 0; above = 0; }
    if (held > 0 && below >= 3) { held = 0; ev.push({ i, type: 'exit' }); continue; }
    if (held === 0 && above >= 3) { held = 1; ev.push({ i, type: 'buy1' }); }
    if (held === 1 && above >= 10) { held = 2; ev.push({ i, type: 'buy2' }); }
    if (held === 2 && above >= 1 && s50 > s200) { held = 3; ev.push({ i, type: 'buy3' }); }
  }
  return { ev, held, below, above };
}
function run(ev, withCash) {
  const start = 199, byI = {}; ev.forEach(e => (byI[e.i] = byI[e.i] || []).push(e));
  let held = 3, eq = 1, peak = 1, dd = 0, bh = 1, bhPeak = 1, bhDD = 0;
  for (let i = start; i < closes.length - 1; i++) {
    for (const e of byI[i] || []) held = e.type === 'exit' ? 0 : +e.type.slice(3);
    const ret = closes[i + 1] / closes[i] - 1, cash = withCash ? Math.pow(1 + cashRate[i] / 100, 1 / 252) - 1 : 0;
    eq *= 1 + ret * held / 3 + cash * (3 - held) / 3; bh *= 1 + ret;
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
    bhPeak = Math.max(bhPeak, bh); bhDD = Math.min(bhDD, bh / bhPeak - 1);
  }
  const yrs = (closes.length - 1 - start) / 252;
  return { cagr: Math.pow(eq, 1 / yrs) - 1, dd, bhCagr: Math.pow(bh, 1 / yrs) - 1, bhDD, yrs };
}
const pct = x => (x * 100).toFixed(1) + '%';
for (const b of [0, 0.005, 0.01, 0.02]) {
  const r = rules(b), exits = r.ev.filter(e => e.type === 'exit');
  let whips = 0;
  for (const x of exits) { const back = r.ev.find(e => e.i > x.i && e.type === 'buy1'); if (back && back.i - x.i <= 40 && closes[back.i] > closes[x.i]) whips++; }
  const z = run(r.ev, false), c = run(r.ev, true);
  const lastEv = r.ev.slice(-2).map(e => `${dates[e.i]} ${e.type}`).join(', ');
  console.log(`band ${(b * 100).toFixed(1)}%: exits ${exits.length}, quick costly re-entries ${whips} | cash 0%: ${pct(z.cagr)}/yr | cash at T-bill: ${pct(c.cagr)}/yr, worst drop ${pct(c.dd)} | now: held ${r.held}/3, below ${r.below}, above ${r.above} | last: ${lastEv}`);
  if (b === 0) console.log(`  buy & hold: ${pct(z.bhCagr)}/yr, worst drop ${pct(z.bhDD)}, over ${z.yrs.toFixed(1)} years`);
}
