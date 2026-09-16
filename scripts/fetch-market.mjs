/**
 * Daily market data collector.
 *
 * Runs in GitHub Actions, not in the browser, which changes everything:
 * there is no CORS server-side, no subrequest cap, and no API key to expose.
 * It writes data/market.json into the repo, and the page then reads that file
 * from its own origin — so the data path the app depends on cannot be broken
 * by a third party's CORS policy or by a free proxy going dark.
 *
 * Breadth is a real census here. In the browser it was 500 requests per page
 * load through rate-limited proxies, which is why it usually failed; here it
 * happens once a day on a runner with a real network.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { getHistory } from '../worker.js';
import { SP500 } from './sp500.mjs';

const OUT = 'data/market.json';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function sma(arr, n) {
  if (arr.length < n) return null;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

async function withRetry(fn, tries = 3, label = '') {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) { last = e; if (i < tries - 1) await sleep(400 * (i + 1)); }
  }
  throw new Error(`${label}: ${last.message}`);
}

// ── Breadth ──────────────────────────────────────────────────────────
// Try the published index first: it is the same statistic, already computed.
// Only fall back to counting, and say plainly which one produced the number.
async function collectBreadth() {
  try {
    const { closes } = await getHistory('^S5TH', '5d', 2);
    const v = closes[closes.length - 1];
    if (isFinite(v) && v >= 0 && v <= 100) {
      console.log(`breadth: ^S5TH = ${v}%`);
      return { value: Math.round(v), method: 'index:^S5TH', counted: 503, above: null };
    }
    console.log(`breadth: ^S5TH gave an implausible ${v}, counting instead`);
  } catch (e) {
    console.log(`breadth: ^S5TH unavailable (${e.message}), counting instead`);
  }

  let above = 0, below = 0, counted = 0, failed = 0;
  const BATCH = 10;
  for (let i = 0; i < SP500.length; i += BATCH) {
    const chunk = SP500.slice(i, i + BATCH);
    const rs = await Promise.allSettled(chunk.map(s => getHistory(s, '300d', 200)));
    rs.forEach(r => {
      if (r.status !== 'fulfilled') { failed++; return; }
      const c = r.value.closes;
      const m = sma(c, 200);
      if (m == null) { failed++; return; }
      counted++;
      if (c[c.length - 1] > m) above++; else below++;
    });
    if (i % 100 === 0) console.log(`  ...${i + chunk.length}/${SP500.length}`);
    await sleep(250);   // be a polite client; this runs once a day
  }
  console.log(`breadth: counted ${counted}, failed ${failed}`);
  if (counted < 300) throw new Error(`census too incomplete: only ${counted} of ${SP500.length}`);
  return {
    value: Math.round((above / counted) * 100),
    method: `census:${counted}`,
    counted, above, below, failed,
  };
}

// ── Everything the macro page reads ──────────────────────────────────
const MACRO = [
  ['vix',    '^VIX',      '5d'],
  ['gold',   'GC=F',      '5d'],
  ['oil',    'CL=F',      '5d'],
  ['dxy',    'DX-Y.NYB',  '5d'],
  ['w5000',  '^W5000',    '5d'],
  // No US-listed ETF tracks this, so the page can only get it from here.
  ['ta125',  '^TA125.TA', '5d'],
];

// FX comes from the ECB via Frankfurter rather than Yahoo: official rates,
// keyless, and the same source the page itself uses, so the snapshot and the
// live row cannot disagree about what the rate was.
async function collectFx() {
  const out = {};
  const from = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  for (const [key, sym, invert] of [['usdils', 'ILS', false], ['eurusd', 'EUR', true]]) {
    try {
      const res = await fetch(`https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=${sym}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const d = await res.json();
      const days = Object.keys(d.rates || {}).sort();
      if (!days.length) throw new Error('no rates');
      let last = d.rates[days[days.length - 1]][sym];
      let prev = days.length > 1 ? d.rates[days[days.length - 2]][sym] : null;
      if (last == null) throw new Error('no rate');
      let change = prev ? ((last - prev) / prev) * 100 : null;
      if (invert) { last = 1 / last; if (change != null) change = -change; }
      out[key] = { value: last, change, asOf: Date.parse(days[days.length - 1] + 'T00:00:00Z') / 1000, source: 'ecb' };
      console.log(`fx ${key}: ${last.toFixed(4)} (ecb)`);
    } catch (e) {
      out[key] = { value: null, error: e.message };
      console.log(`fx ${key}: FAILED — ${e.message}`);
    }
  }
  return out;
}

async function collectMacro() {
  const out = {};
  for (const [key, symbol, range] of MACRO) {
    try {
      const { closes, stamps, source } = await withRetry(
        () => getHistory(symbol, range, 2), 3, symbol);
      const price = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      out[key] = {
        value: price,
        change: prev ? ((price - prev) / prev) * 100 : null,
        asOf: stamps[stamps.length - 1],
        source,
      };
      console.log(`macro ${key}: ${price.toFixed(2)} (${source})`);
    } catch (e) {
      out[key] = { value: null, error: e.message };
      console.log(`macro ${key}: FAILED — ${e.message}`);
    }
  }
  return out;
}

// The ETFs the price page quotes live from Finnhub. Snapshotting them too
// means the page still has something to show when there is no Finnhub key,
// or when Finnhub is down — marked as not live rather than left blank.
const ETFS = ['SPY','QQQ','DIA','GLD','USO','IBIT','TLT','IEF','BIL','UUP','VIXY','EIS'];

async function collectQuotes() {
  const out = {};
  const rs = await Promise.allSettled(ETFS.map(s => getHistory(s, '5d', 2)));
  rs.forEach((r, i) => {
    const sym = ETFS[i];
    if (r.status !== 'fulfilled') { out[sym] = { value: null, error: r.reason.message }; return; }
    const c = r.value.closes;
    const price = c[c.length - 1], prev = c[c.length - 2];
    out[sym] = {
      value: price,
      change: prev ? ((price - prev) / prev) * 100 : null,
      asOf: r.value.stamps[r.value.stamps.length - 1],
    };
  });
  const ok = Object.values(out).filter(q => q.value != null).length;
  console.log(`quotes: ${ok}/${ETFS.length} ETFs`);
  return out;
}

// The yield curve needs a two-year weekly series, not just a spot value.
async function collectYields() {
  const out = {};
  for (const [key, symbol] of [['tnx', '^TNX'], ['irx', '^IRX'], ['tyx', '^TYX']]) {
    try {
      const { closes, stamps, source } = await withRetry(
        () => getHistory(symbol, '2y', 20), 3, symbol);
      // thin a daily series down to roughly weekly to keep the file small
      const step = Math.max(1, Math.round(closes.length / 104));
      const c = [], t = [];
      for (let i = 0; i < closes.length; i += step) { c.push(closes[i]); t.push(stamps[i]); }
      if (c.at(-1) !== closes.at(-1)) { c.push(closes.at(-1)); t.push(stamps.at(-1)); }
      out[key] = { closes: c, stamps: t, latest: closes.at(-1), source };
      console.log(`yield ${key}: ${closes.at(-1)} (${c.length} pts, ${source})`);
    } catch (e) {
      out[key] = { closes: [], stamps: [], latest: null, error: e.message };
      console.log(`yield ${key}: FAILED — ${e.message}`);
    }
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────
const started = Date.now();
console.log('collecting market data...');

const sp = await withRetry(() => getHistory('^GSPC', '300d', 210), 4, '^GSPC');
console.log(`sp500: ${sp.closes.length} bars from ${sp.source}`);

const [breadth, macro, yields, quotes, fx] = await Promise.all([
  collectBreadth().catch(e => ({ value: null, method: 'failed', error: e.message })),
  collectMacro(),
  collectYields(),
  collectQuotes().catch(e => ({ error: e.message })),
  collectFx().catch(e => ({ error: e.message })),
]);
Object.assign(macro, fx);   // the page reads FX out of macro alongside the rest

const payload = {
  generated: new Date().toISOString(),
  sp500: { closes: sp.closes, stamps: sp.stamps, source: sp.source, sma200: sma(sp.closes, 200) },
  breadth,
  macro,
  yields,
  quotes,
};

await mkdir('data', { recursive: true });
await writeFile(OUT, JSON.stringify(payload));
const kb = (JSON.stringify(payload).length / 1024).toFixed(1);
console.log(`\nwrote ${OUT} (${kb} KB) in ${((Date.now() - started) / 1000).toFixed(1)}s`);

// A run that produced no usable S&P series is a failed run — fail loudly
// rather than committing a file the page will silently render as blank.
if (!payload.sp500.closes.length || payload.sp500.sma200 == null) {
  console.error('FATAL: no usable S&P 500 series');
  process.exit(1);
}
