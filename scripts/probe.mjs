/**
 * Backtest the portfolio rules on the S&P 500's daily closes since 2006, old
 * rules against the new ones. The stock sleeve only: cash earns nothing here,
 * which flatters neither side.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const ctx = {}; vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('./strategy.js', import.meta.url), 'utf8'), ctx);

const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=SP500&api_key=${process.env.FRED_API_KEY}&file_type=json&observation_start=2006-01-01`);
const obs = (await r.json()).observations.map(o => ({ date: o.date, v: parseFloat(o.value) })).filter(o => isFinite(o.v));
const closes = obs.map(o => o.v), stamps = obs.map(o => Date.parse(o.date + 'T00:00:00Z') / 1000);
console.log(`S&P closes: ${obs.length}, ${obs[0].date} .. ${obs.at(-1).date}`);

const day = s => new Date(s * 1000).toISOString().slice(0, 10);

// The old rules, for comparison: exit after 3 closes below; first third on the
// first close above; second after 10 above; last at the 50/200 cross. No rule
// for falling back mid-way, so here a mid-way fall is treated like the exit.
function oldRules(closes, stamps) {
  const avg = (a, i, n) => { if (i + 1 < n) return null; let s = 0; for (let k = i - n + 1; k <= i; k++) s += a[k]; return s / n; };
  let held = 3, below = 0, above = 0; const ev = [];
  for (let i = 0; i < closes.length; i++) {
    const s200 = avg(closes, i, 200); if (s200 == null) continue; const s50 = avg(closes, i, 50);
    if (closes[i] < s200) { below++; above = 0; } else { above++; below = 0; }
    if (held > 0 && below >= 3) { held = 0; ev.push({ i, date: stamps[i], type: 'exit' }); continue; }
    if (held === 0 && above >= 1) { held = 1; ev.push({ i, date: stamps[i], type: 'buy1' }); }
    if (held === 1 && above >= 10) { held = 2; ev.push({ i, date: stamps[i], type: 'buy2' }); }
    if (held === 2 && s50 > s200 && above >= 1) { held = 3; ev.push({ i, date: stamps[i], type: 'buy3' }); }
  }
  return { events: ev };
}

// Equity of the stock sleeve: exposure (thirds held) decided at a close earns
// the next day's return.
function run(events) {
  const start = 199;
  let held = 3, eq = 1, peak = 1, maxDD = 0, bh = 1, bhPeak = 1, bhDD = 0, k = 0, trades = 0;
  const byI = {}; events.forEach(e => (byI[e.i] = byI[e.i] || []).push(e));
  for (let i = start; i < closes.length - 1; i++) {
    for (const e of byI[i] || []) { held = e.type === 'exit' ? 0 : +e.type.slice(3); trades++; }
    const ret = closes[i + 1] / closes[i] - 1;
    eq *= 1 + ret * held / 3; bh *= 1 + ret;
    peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq / peak - 1);
    bhPeak = Math.max(bhPeak, bh); bhDD = Math.min(bhDD, bh / bhPeak - 1);
  }
  const years = (closes.length - start) / 252;
  return { total: eq, cagr: Math.pow(eq, 1 / years) - 1, maxDD, bh, bhCagr: Math.pow(bh, 1 / years) - 1, bhDD, trades };
}
const pct = x => (x * 100).toFixed(1) + '%';

const now = ctx.strategyState(closes, stamps);
const old = oldRules(closes, stamps);
for (const [name, ev] of [['NEW', now.events], ['OLD', old.events]]) {
  const res = run(ev);
  const exits = ev.filter(e => e.type === 'exit');
  // A whipsaw: an exit followed by a full re-entry within 40 trading days at a higher level
  let whips = 0;
  for (const x of exits) {
    const back = ev.find(e => e.i > x.i && e.type === 'buy1');
    if (back && back.i - x.i <= 40 && closes[back.i] > closes[x.i]) whips++;
  }
  console.log(`\n${name}: exits ${exits.length}, quick re-entries above the exit price ${whips}, trades ${res.trades}`);
  console.log(`  stock sleeve: ${pct(res.cagr)}/yr, worst drop ${pct(res.maxDD)}  |  buy & hold: ${pct(res.bhCagr)}/yr, worst drop ${pct(res.bhDD)}`);
}
console.log('\nNEW events:');
for (const e of now.events) console.log(`  ${day(e.date)}  ${e.type.padEnd(5)} ${closes[e.i].toFixed(0)}`);
console.log('\nNOW:', JSON.stringify({ held: now.held, below: now.below, above: now.above, close: now.close, date: day(now.date),
  sma200: +now.sma200.toFixed(1), sma50: +now.sma50.toFixed(1), gapPct: +now.gapPct.toFixed(2), golden: now.golden, today: now.today }));
