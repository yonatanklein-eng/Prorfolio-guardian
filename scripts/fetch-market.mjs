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
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { getHistory, yahooQuoteBatch } from '../worker.js';
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
async function breadthFromIndexSeries() {
  const { closes } = await getHistory('^S5TH', '5d', 2);
  const v = closes[closes.length - 1];
  if (!isFinite(v) || v < 0 || v > 100) throw new Error(`implausible value ${v}`);
  return { value: Math.round(v), method: 'index:^S5TH', counted: 503, above: null };
}

// Yahoo's chart endpoint is undocumented and unsanctioned, and it throttles.
// Firing ~500 requests at it in one run is asking to be blocked, and a run
// blocked halfway yields a number built from whatever happened to answer —
// exactly the confident-looking nonsense this app should not print.
//
// So prefer ^S5TH, which publishes this statistic as an index and costs one
// request. Only if that is unavailable, count — and count by ROTATION,
// refreshing a slice per run and carrying the rest forward. No run bursts,
// and a throttled run costs freshness rather than correctness.
const REFRESH_PER_RUN = Number(process.env.BREADTH_REFRESH || 60);

// The whole index in ten requests. v7/finance/quote takes 50 symbols at a
// time and hands back twoHundredDayAverage per symbol, so there is nothing to
// compute from history and nothing to spread over days.
async function breadthFromBatchQuotes() {
  const CHUNK = 50;
  let above = 0, counted = 0, missing = 0, requests = 0;

  for (let i = 0; i < SP500.length; i += CHUNK) {
    const chunk = SP500.slice(i, i + CHUNK);
    let rows;
    try {
      rows = await yahooQuoteBatch(chunk);
      requests++;
    } catch (e) {
      // One retry: a rejected crumb clears the cache, so the retry re-handshakes.
      if (!/crumb rejected/.test(e.message)) throw e;
      rows = await yahooQuoteBatch(chunk);
      requests += 2;
    }
    const seen = new Set();
    rows.forEach(q => {
      const p = q.regularMarketPrice, m = q.twoHundredDayAverage;
      if (!isFinite(p) || !isFinite(m) || m <= 0) return;
      seen.add(q.symbol);
      counted++;
      if (p > m) above++;
    });
    missing += chunk.length - seen.size;
    await sleep(300);
  }

  console.log(`breadth: ${counted} counted, ${missing} missing, ${requests} requests`);
  if (counted < SP500.length * 0.8) {
    throw new Error(`batch too incomplete: ${counted} of ${SP500.length}`);
  }
  return {
    value: Math.round((above / counted) * 100),
    method: `batch:${counted}`,
    counted, above, below: counted - above,
  };
}

// ── Breadth by splitting the problem ─────────────────────────────────
// Nobody free will sell 500 stocks' worth of daily history every day. But the
// two halves of "is this stock above its 200-day line" have very different
// shelf lives:
//
//   the PRICE moves every day, and must be today's
//   the 200-DAY AVERAGE barely moves — one more day shifts it by a fraction
//   of a percent, since it is an average of two hundred of them
//
// So take each from the source that can afford it. Finnhub quotes 60/min and
// covers US stocks, so all ~500 prices are today's. Twelve Data's 800 credits
// a day refresh the averages on rotation, a slice per run. The reading is
// same-day across the whole index; the only staleness is in the half that
// hardly changes.
// 493 averages cost 493 of the 800 daily credits, so the whole index fits in
// one day. Split across the day's runs, with anything refreshed in the last
// ~20 hours left alone, so later runs cost almost nothing.
const TD_PER_RUN = Number(process.env.TD_PER_RUN || 250);
const SMA_FRESH_H = Number(process.env.SMA_FRESH_H || 20);
const TD_BATCH = 8;                                          // = the 8/min limit
// Pacing is overridable so tests do not sit through the real rate limits.
const TD_PACE_MS = Number(process.env.TD_PACE_MS || 61000);
const FH_PACE_MS = Number(process.env.FH_PACE_MS || 31000);

async function twelveDataSMA(symbols, key) {
  const url = 'https://api.twelvedata.com/sma'
    + `?symbol=${symbols.join(',')}&interval=1day&time_period=200&series_type=close`
    + `&outputsize=1&apikey=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('twelvedata ' + res.status);
  const d = await res.json();
  const out = {};
  // one symbol comes back bare; several come back keyed by symbol
  const rows = symbols.length === 1 ? { [symbols[0]]: d } : d;
  for (const sym of symbols) {
    const r = rows[sym];
    const v = parseFloat(r && r.values && r.values[0] && r.values[0].sma);
    if (isFinite(v) && v > 0) out[sym] = v;
  }
  return out;
}

async function finnhubPrice(symbol, key) {
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${key}`);
  if (!res.ok) throw new Error('finnhub ' + res.status);
  const d = await res.json();
  return isFinite(d.c) && d.c > 0 ? d.c : null;
}

async function breadthFromCombined(prev) {
  const tdKey = process.env.TWELVEDATA_API_KEY;
  const fhKey = process.env.FINNHUB_API_KEY;
  if (!tdKey) throw new Error('no twelvedata key');
  if (!fhKey) throw new Error('no finnhub key');

  // ── 1. refresh the stalest averages ──
  const smas = Object.assign({}, (prev && prev.breadthSMA) || {});
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const stale = sym => {
    const e = smas[sym];
    if (!e || !e.ts) return true;
    return (now - e.ts) / 3600000 >= SMA_FRESH_H;
  };
  const queue = SP500.filter(stale)
    .sort((a, b) => ((smas[a] && smas[a].ts) || 0) - ((smas[b] && smas[b].ts) || 0));
  const todo = queue.slice(0, TD_PER_RUN);
  console.log(`breadth: ${queue.length} averages stale, refreshing ${todo.length}`);

  let refreshed = 0;
  for (let i = 0; i < todo.length; i += TD_BATCH) {
    const chunk = todo.slice(i, i + TD_BATCH);
    try {
      const got = await twelveDataSMA(chunk, tdKey);
      for (const [sym, v] of Object.entries(got)) { smas[sym] = { v, t: today, ts: now }; refreshed++; }
    } catch (e) {
      console.log(`  sma batch failed: ${e.message}`);
      if (/429|limit/i.test(e.message)) break;     // out of credits; keep what we have
    }
    if (i + TD_BATCH < todo.length) await sleep(TD_PACE_MS);   // stay under 8 credits/min
  }
  console.log(`breadth: refreshed ${refreshed} averages, ${Object.keys(smas).length} known`);

  const known = Object.keys(smas);
  if (!known.length) {
    return { value: null, method: 'building', counted: 0, smas,
             error: `עוד לא נאספו ממוצעים` };
  }

  // ── 2. today's price for everything we have an average for ──
  let above = 0, counted = 0, priceFails = 0;
  const FH_BATCH = 30;                                  // under 60/min
  for (let i = 0; i < known.length; i += FH_BATCH) {
    const chunk = known.slice(i, i + FH_BATCH);
    const rs = await Promise.allSettled(chunk.map(sym => finnhubPrice(sym, fhKey)));
    rs.forEach((r, j) => {
      const sym = chunk[j];
      if (r.status !== 'fulfilled' || r.value == null) { priceFails++; return; }
      counted++;
      if (r.value > smas[sym].v) above++;
    });
    if (i + FH_BATCH < known.length) await sleep(FH_PACE_MS);
  }
  console.log(`breadth: priced ${counted}, failed ${priceFails}`);

  // Two different questions. Could we price what we have averages for — if not,
  // the price source is broken and the next layer should try. And do we cover
  // enough of the index to call it a reading — if not, keep building, but keep
  // the table either way rather than throwing the run's work away.
  if (known.length && counted < known.length * 0.8) {
    throw new Error(`priced only ${counted} of ${known.length} known`);
  }
  if (counted < SP500.length * 0.8) {
    return {
      value: null, method: 'building', counted, smas, refreshed,
      error: `נמדדו ${counted} מתוך ${SP500.length} מניות — הכיסוי עוד נבנה`,
    };
  }

  const oldest = known.reduce((acc, k) => (smas[k].t < acc ? smas[k].t : acc), today);
  return {
    value: Math.round((above / counted) * 100),
    method: `combined:${counted}`,
    counted, above, below: counted - above,
    refreshed, oldestAverage: oldest,
    smas,
  };
}

async function collectBreadth(prev) {
  try {
    const r = await breadthFromIndexSeries();
    console.log(`breadth: ^S5TH = ${r.value}% (1 request)`);
    return r;
  } catch (e) {
    console.log(`breadth: ^S5TH unavailable (${e.message})`);
  }

  try {
    return await breadthFromBatchQuotes();
  } catch (e) {
    console.log(`breadth: batch quotes failed (${e.message})`);
  }

  try {
    return await breadthFromCombined(prev);
  } catch (e) {
    console.log(`breadth: combined sources failed (${e.message}) — rotating instead`);
  }

  const state = Object.assign({}, (prev && prev.breadthState) || {});
  const today = new Date().toISOString().slice(0, 10);

  // Never-checked first, then oldest.
  const queue = SP500.slice()
    .sort((a, b) => ((state[a] && state[a].t) || '').localeCompare((state[b] && state[b].t) || ''));
  const todo = queue.slice(0, REFRESH_PER_RUN);
  console.log(`breadth: refreshing ${todo.length} of ${SP500.length} this run`);

  let refreshed = 0, failed = 0;
  const BATCH = 5;
  for (let i = 0; i < todo.length; i += BATCH) {
    const rs = await Promise.allSettled(todo.slice(i, i + BATCH).map(sym => getHistory(sym, '300d', 200)));
    rs.forEach((r, j) => {
      const sym = todo[i + j];
      if (r.status !== 'fulfilled') { failed++; return; }
      const c = r.value.closes;
      const m = sma(c, 200);
      if (m == null) { failed++; return; }
      state[sym] = { a: c[c.length - 1] > m ? 1 : 0, t: today };
      refreshed++;
    });
    await sleep(400);
  }

  const known = Object.keys(state);
  const above = known.filter(k => state[k].a === 1).length;
  console.log(`breadth: refreshed ${refreshed}, failed ${failed}, known ${known.length}/${SP500.length}`);

  if (known.length < 100) {
    // Too thin to mean anything. Say so rather than print something that
    // looks like a market reading.
    return {
      value: null, method: 'building', counted: known.length,
      error: `נאספו ${known.length} מתוך ${SP500.length} מניות — עוד לא מספיק לקריאה`,
      state,
    };
  }

  const oldest = known.reduce((acc, k) => (state[k].t < acc ? state[k].t : acc), today);

  return {
    value: Math.round((above / known.length) * 100),
    method: `rotating:${known.length}`,
    counted: known.length,
    above, below: known.length - above,
    refreshed, oldestReading: oldest,
    state,
  };
}

// ── Everything the macro page reads ──────────────────────────────────
// ── Buffett indicator ────────────────────────────────────────────────
// Total US corporate equities over GDP. The Wilshire 5000 series this used to
// lean on was withdrawn from FRED — FRED's own search returns nothing for it —
// but the ratio the indicator is actually defined as is still there:
// BOGZ1LM883164115Q (Fed Z.1, corporate equities, millions) over GDP
// (BEA, billions). Both quarterly, so take the latest observation of each.
async function fredLatest(seriesId) {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('no api key');
  const url = 'https://api.stlouisfed.org/fred/series/observations'
    + `?series_id=${seriesId}&api_key=${key}&file_type=json`
    + '&sort_order=desc&limit=8';
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fred ${res.status} (${seriesId})`);
  const d = await res.json();
  for (const o of d.observations || []) {          // newest first; "." = missing
    const v = parseFloat(o.value);
    if (isFinite(v)) return { value: v, date: o.date };
  }
  throw new Error(`${seriesId}: no observations`);
}

async function collectBuffett() {
  try {
    const [eq, gdp] = await Promise.all([
      fredLatest('BOGZ1LM883164115Q'),
      fredLatest('GDP'),
    ]);
    // equities are millions, GDP billions — divide the first by 1000 to match
    const pct = (eq.value / 1000) / gdp.value * 100;
    if (!isFinite(pct) || pct <= 0 || pct > 1000) throw new Error(`implausible ${pct}`);
    console.log(`buffett: ${pct.toFixed(1)}%  (equities ${eq.date}, gdp ${gdp.date})`);
    return {
      value: Math.round(pct), asOf: eq.date, gdpAsOf: gdp.date,
      source: 'fred', series: 'BOGZ1LM883164115Q/GDP',
    };
  } catch (e) {
    console.log(`buffett: FAILED — ${e.message}`);
    return { value: null, error: e.message };
  }
}

// What to ask FRED for when a symbol's ids all fail.
const SEARCH_HINT = { w5000: 'Wilshire 5000 Total Market Index' };

const MACRO = [
  ['vix',    '^VIX',      '5d'],
  ['gold',   'GC=F',      '5d'],
  ['oil',    'CL=F',      '5d'],
  ['dxy',    'DX-Y.NYB',  '5d'],
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

// Four guessed Wilshire ids all came back 400, so stop guessing: FRED can be
// asked what it actually has. Runs only when a symbol's candidates all fail,
// and only logs — the next run uses whatever this turns up.
async function suggestFredSeries(text) {
  const key = process.env.FRED_API_KEY;
  if (!key) return;
  try {
    const url = 'https://api.stlouisfed.org/fred/series/search'
      + `?search_text=${encodeURIComponent(text)}&api_key=${key}&file_type=json`
      + '&limit=8&order_by=popularity&sort_order=desc';
    const res = await fetch(url);
    if (!res.ok) { console.log(`  search "${text}": HTTP ${res.status}`); return; }
    const d = await res.json();
    const hits = (d.seriess || []).map(x => `${x.id} (${x.frequency_short}, ${x.observation_end}) — ${x.title}`);
    console.log(`  FRED has for "${text}":`);
    hits.forEach(h => console.log('    ' + h));
  } catch (e) { console.log(`  search "${text}" failed: ${e.message}`); }
}

async function collectMacro() {
  const out = {};
  for (const [key, symbol, range] of MACRO) {
    try {
      const { closes, stamps, source, series } = await withRetry(
        () => getHistory(symbol, range, 2), 3, symbol);
      const price = closes[closes.length - 1];
      const prev = closes[closes.length - 2];
      out[key] = {
        value: price,
        change: prev ? ((price - prev) / prev) * 100 : null,
        asOf: stamps[stamps.length - 1],
        source,
      };
      if (series) out[key].series = series;
      console.log(`macro ${key}: ${price.toFixed(2)} (${source}${out[key].series ? ':' + out[key].series : ''})`);
    } catch (e) {
      out[key] = { value: null, error: e.message };
      console.log(`macro ${key}: FAILED — ${e.message}`);
      if (/fred 400/.test(e.message)) await suggestFredSeries(SEARCH_HINT[key] || key);
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
        // Five years, not two: the timing model is about when the curve came
        // back from its last real inversion, and 2022-24's was too long and too
        // early to fit inside a two-year window — the card could not see it.
        () => getHistory(symbol, '5y', 20), 3, symbol);
      // thin a daily series down to roughly weekly to keep the file small
      const step = Math.max(1, Math.round(closes.length / 260));   // ~weekly over 5y
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

// Rotation builds on what earlier runs established.
let prev = null;
try { prev = JSON.parse(await readFile(OUT, 'utf8')); console.log('loaded previous snapshot'); }
catch { console.log('no previous snapshot — starting fresh'); }

const sp = await withRetry(() => getHistory('^GSPC', '300d', 210), 4, '^GSPC');
console.log(`sp500: ${sp.closes.length} bars from ${sp.source}`);

const [breadth, macro, yields, quotes, fx, buffett] = await Promise.all([
  collectBreadth(prev).catch(e => ({ value: null, method: 'failed', error: e.message })),
  collectMacro(),
  collectYields(),
  collectQuotes().catch(e => ({ error: e.message })),
  collectFx().catch(e => ({ error: e.message })),
  collectBuffett(),
]);
Object.assign(macro, fx);   // the page reads FX out of macro alongside the rest
macro.buffett = buffett;

// The per-ticker table is bookkeeping for the next run, not something the
// page renders — keep it out of the breadth block it reads.
const breadthState = breadth.state;
const breadthSMA = breadth.smas;
delete breadth.state;
delete breadth.smas;

const payload = {
  generated: new Date().toISOString(),
  breadthState,
  breadthSMA,
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
