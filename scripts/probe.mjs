/**
 * Audit: every number the four screens show, against a source other than the
 * one it came from. Reads the snapshot the site is serving (main's
 * data/market.json), works out what each screen displays from it the same way
 * the page does, and prints each next to its independent reference.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const get = (url, h = {}) => fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...h },
                                           signal: AbortSignal.timeout(25000) });
const json = async (url, h) => { const r = await get(url, h); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const text = async (url, h) => { const r = await get(url, h); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
const FRED = id => `https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${process.env.FRED_API_KEY}&file_type=json`;
const TD = q => `https://api.twelvedata.com/${q}&apikey=${process.env.TWELVEDATA_API_KEY}`;
// Twelve Data allows 8 requests a minute: space them out.
let tdLast = 0;
const tdJson = async url => {
  const wait = tdLast + 8500 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  tdLast = Date.now();
  return json(url);
};
const FH = s => `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}&token=${process.env.FINNHUB_API_KEY}`;
const num = v => (v == null || v === '' ? NaN : parseFloat(String(v).replace(/[$,%]/g, '')));
const fin = x => typeof x === 'number' && Number.isFinite(x);
const pct = (a, b) => (fin(a) && fin(b) && b ? ((a / b - 1) * 100) : NaN);
const rows = [];
function row(screen, item, shown, ref, refName, tol, note = '') {
  shown = typeof shown === 'string' ? num(shown) : shown;
  ref = typeof ref === 'string' ? num(ref) : ref;
  const d = pct(shown, ref);
  const verdict = !fin(shown) ? 'NO VALUE' : !fin(ref) ? 'NO REF' : Math.abs(d) <= tol ? 'OK' : 'CHECK';
  rows.push({ screen, item, shown: fin(shown) ? +shown.toFixed(4) : '-', ref: fin(ref) ? +ref.toFixed(4) : '-',
              refName, diffPct: fin(d) ? +d.toFixed(3) : '', verdict, note });
}
async function safe(label, fn) { try { return await fn(); } catch (e) { console.log(`  [${label}] ${e.message}`); return null; } }

const snap = await json(`https://raw.githubusercontent.com/yonatanklein-eng/Prorfolio-guardian/main/data/market.json?x=${Date.now()}`);
console.log('snapshot generated', snap.generated);
const nowIso = new Date().toISOString();
console.log('audit time', nowIso);

// ── Live inputs the page would use ──
const fh = {};
for (const s of ['SPY', 'QQQ', 'DIA', 'USO', 'GLD', 'BINANCE:BTCUSDT']) fh[s] = await safe('finnhub ' + s, () => json(FH(s)));
for (const [s, q] of Object.entries(fh)) if (q) console.log(`finnhub ${s}: c=${q.c} pc=${q.pc} t=${new Date(q.t * 1000).toISOString()}`);

// ── Independent references ──
const nasdaq = async (sym, cls) => {
  const d = await json(`https://api.nasdaq.com/api/quote/${sym}/info?assetclass=${cls}`, { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
  const p = d && d.data && d.data.primaryData;
  return p ? { last: num(p.lastSalePrice), time: p.lastTradeTimestamp, change: p.percentageChange } : null;
};
const nq = {};
for (const s of ['SPX', 'NDX', 'INDU', 'DJIA', 'COMP']) nq[s] = await safe('nasdaq ' + s, () => nasdaq(s, 'index'));
for (const [s, v] of Object.entries(nq)) if (v) console.log(`nasdaq ${s}: ${JSON.stringify(v)}`);

const nqHist = async (sym, cls, from) => {
  const d = await json(`https://api.nasdaq.com/api/quote/${sym}/historical?assetclass=${cls}&fromdate=${from}&limit=400`,
                       { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
  const r = (d && d.data && d.data.tradesTable && d.data.tradesTable.rows) || [];
  return r.map(x => ({ date: x.date, close: num(x.close) })).filter(x => isFinite(x.close));
};

// ════════ Screen 1 — main: S&P 500 against its 200-day line ════════
const closes = snap.sp500.closes, stamps = snap.sp500.stamps;
const lastClose = closes.at(-1), lastDay = new Date(stamps.at(-1) * 1000).toISOString().slice(0, 10);
const lv = snap.levels && snap.levels.sp500;
let shownSP = lastClose, series = closes.slice();
if (fh.SPY && lv && lv.ratio) {
  const qd = new Date(fh.SPY.t * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  if (qd > lastDay) { shownSP = fh.SPY.c * lv.ratio; series.push(shownSP); }
}
const sma = a => a.slice(-200).reduce((x, y) => x + y, 0) / 200;
const shownSMA = sma(series);
console.log(`\nmain: last official ${lastClose} (${lastDay}); shown ${shownSP.toFixed(2)}; SMA200 ${shownSMA.toFixed(2)}; points ${closes.length}`);
row('main', 'S&P 500 level', shownSP, nq.SPX && nq.SPX.last, 'Nasdaq SPX', 0.15);
// The 200-day average, recomputed from an independent daily history
const from = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
const spxHist = await safe('nasdaq SPX history', () => nqHist('SPX', 'index', from));
if (spxHist && spxHist.length) {
  const asc = spxHist.slice().reverse();     // oldest first
  const byDate = Object.fromEntries(asc.map(x => {
    const [m, d, y] = x.date.split('/'); return [`${y}-${m}-${d}`, x.close];
  }));
  const ourDates = stamps.map(s => new Date(s * 1000).toISOString().slice(0, 10));
  let mism = 0, compared = 0, worst = 0;
  ourDates.forEach((d, i) => { if (byDate[d] != null) { compared++; const e = Math.abs(closes[i] / byDate[d] - 1); if (e > 0.0005) mism++; worst = Math.max(worst, e); } });
  console.log(`  FRED vs Nasdaq closes: ${compared} days compared, ${mism} differ by >0.05%, worst ${(worst * 100).toFixed(3)}%`);
  const officialSMA = asc.slice(-200).reduce((a, x) => a + x.close, 0) / 200;
  row('main', '200-day average (official closes)', sma(closes), officialSMA, 'SMA from Nasdaq SPX history', 0.05);
  const missing = asc.filter(x => { const [m, d, y] = x.date.split('/'); return !ourDates.includes(`${y}-${m}-${d}`); }).map(x => x.date);
  if (missing.length) console.log(`  days in Nasdaq history but not in ours (last 400d): ${missing.length} e.g. ${missing.slice(0, 6).join(' ')}`);
}

// ════════ Screen 2 — risk ════════
const M = snap.macro;
// VIX: CBOE's own history
const vixCsv = await safe('cboe vix', () => text('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv'));
if (vixCsv) {
  const last = vixCsv.trim().split('\n').at(-1).split(',');
  console.log(`\ncboe VIX last row: ${last.join(' ')}; ours ${M.vix && M.vix.value} (${M.vix && new Date(M.vix.asOf * 1000).toISOString().slice(0, 10)})`);
  // compare against the same date
  const lines = vixCsv.trim().split('\n').slice(1).map(l => l.split(','));
  const ourDate = M.vix && new Date(M.vix.asOf * 1000).toISOString().slice(0, 10);
  const same = lines.find(l => { const [m, d, y] = l[0].split('/'); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` === ourDate; });
  row('risk', `VIX (${ourDate})`, M.vix && M.vix.value, same && num(same[4]), 'CBOE VIX close, same day', 0.5);
}
// Treasury yields: the Treasury's own daily par curve
const yr = new Date().getUTCFullYear();
const tcsv = await safe('treasury', () => text(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${yr}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${yr}&page&_format=csv`));
if (tcsv) {
  const L = tcsv.trim().split('\n'); const head = L[0].split(',').map(h => h.replace(/"/g, ''));
  const byDate = {};
  for (const l of L.slice(1)) { const c = l.split(','); const [m, d, y] = c[0].replace(/"/g, '').split('/'); byDate[`${y}-${m}-${d}`] = Object.fromEntries(head.map((h, i) => [h, num(c[i])])); }
  for (const [k, col] of [['irx', '3 Mo'], ['tnx', '10 Yr'], ['tyx', '30 Yr']]) {
    const y = snap.yields[k]; const d = y.latestDate || new Date(y.stamps.at(-1) * 1000).toISOString().slice(0, 10);
    row('risk/prices', `${col} yield (${d})`, y.latest, byDate[d] && byDate[d][col], 'US Treasury par curve, same day', 0.5);
  }
  const t = snap.yields.tnx, i3 = snap.yields.irx;
  console.log(`\nyield curve card: spread ${(t.latest - i3.latest).toFixed(2)} from ${t.latest} − ${i3.latest}`);
}
// Gold: two spot sources
const goldApi = await safe('gold-api', () => json('https://api.gold-api.com/price/XAU'));
const tdGold = await safe('td gold', () => tdJson(TD('price?symbol=XAU/USD')));
console.log(`\ngold: ours ${M.gold && M.gold.value} (${M.gold && M.gold.source}); gold-api now ${goldApi && goldApi.price}; twelvedata now ${tdGold && tdGold.price}`);
row('risk/prices', 'gold spot now (gold-api, what the page reads)', goldApi && num(goldApi.price), tdGold && num(tdGold.price), 'Twelve Data XAU/USD', 0.3);
// Oil
const tdOil = await safe('td oil', () => tdJson(TD('quote?symbol=WTI/USD')));
console.log(`oil: FRED WTI ${M.oil && M.oil.value} (${M.oil && new Date(M.oil.asOf * 1000).toISOString().slice(0, 10)}); twelvedata WTI/USD ${tdOil && JSON.stringify(tdOil).slice(0, 200)}`);
// DXY: same formula on Twelve Data's live rates (independent of the ECB fixing time)
const fx = {};
for (const p of ['EUR/USD', 'USD/JPY', 'GBP/USD', 'USD/CAD', 'USD/SEK', 'USD/CHF', 'USD/ILS']) {
  const r = await safe('td ' + p, () => tdJson(TD('price?symbol=' + p))); fx[p] = r && num(r.price);
}
const dxyTD = 50.14348112 * Math.pow(fx['EUR/USD'], -0.576) * Math.pow(fx['USD/JPY'], 0.136) * Math.pow(fx['GBP/USD'], -0.119)
  * Math.pow(fx['USD/CAD'], 0.091) * Math.pow(fx['USD/SEK'], 0.042) * Math.pow(fx['USD/CHF'], 0.036);
row('risk/prices', 'DXY', M.dxy && M.dxy.value, dxyTD, 'ICE formula on Twelve Data live FX', 0.6, 'ECB fixing vs now');
// Buffett: what the series is made of
console.log('\nBuffett indicator inputs:');
for (const id of ['BOGZ1LM883164115Q', 'NCBEILQ027S', 'BOGZ1LM793164105Q', 'BOGZ1LM263164103Q', 'BOGZ1FL893064105Q', 'GDP']) {
  const d = await safe('fred ' + id, () => json(FRED(id) + '&sort_order=desc&limit=1'));
  const o = d && d.observations && d.observations[0];
  console.log(`  ${id.padEnd(18)} ${o ? `${o.date} ${o.value}` : '-'}`);
}
console.log(`  ours: ${JSON.stringify(M.buffett)}`);
// CAPE, savings, concentration: print with their dates
console.log(`\nCAPE ${JSON.stringify(M.cape)}`);
console.log(`savings ${JSON.stringify(M.savings)}`);
console.log(`concentration top10 ${M.concentration && M.concentration.top10} as of ${M.concentration && M.concentration.asOf}`);
const ps = await safe('fred PSAVERT', () => json(FRED('PSAVERT') + '&sort_order=desc&limit=1'));
row('risk', 'saving rate', M.savings && M.savings.value, ps && num(ps.observations[0].value), 'FRED PSAVERT now', 0);

// ════════ Screen 3 — prices ════════
const lev = snap.levels || {};
const live = (k, e) => (fh[e] && lev[k] && lev[k].ratio ? fh[e].c * lev[k].ratio : NaN);
console.log('\nlevels:', JSON.stringify(lev));
row('prices', 'S&P 500', live('sp500', 'SPY'), nq.SPX && nq.SPX.last, 'Nasdaq SPX', 0.15);
row('prices', 'Nasdaq-100', live('ndx', 'QQQ'), nq.NDX && nq.NDX.last, 'Nasdaq NDX', 0.15);
row('prices', 'Dow Jones', live('djia', 'DIA'), (nq.INDU && nq.INDU.last) || (nq.DJIA && nq.DJIA.last), 'Nasdaq DJIA', 0.15);
row('prices', 'WTI via USO', live('wti', 'USO'), tdOil && num(tdOil.close), 'Twelve Data WTI/USD', 1.5, 'USO ratio drifts with futures roll');
const cg = await safe('coingecko', () => json('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd'));
const tdBtc = await safe('td btc', () => tdJson(TD('price?symbol=BTC/USD')));
row('prices', 'Bitcoin (CoinGecko, what the page reads)', cg && cg.bitcoin && cg.bitcoin.usd, tdBtc && num(tdBtc.price), 'Twelve Data BTC/USD', 0.5);
const boi = await safe('bank of israel', () => json('https://boi.org.il/PublicApi/GetExchangeRates'));
const boiUsd = boi && boi.exchangeRates && boi.exchangeRates.find(r => r.key === 'USD');
console.log(`\nBank of Israel USD: ${boiUsd && JSON.stringify(boiUsd)}`);
row('prices', 'USD/ILS (ECB)', M.usdils && M.usdils.value, boiUsd && boiUsd.currentExchangeRate, 'Bank of Israel representative rate', 0.5);
row('prices', 'USD/ILS (ECB)', M.usdils && M.usdils.value, fx['USD/ILS'], 'Twelve Data live', 0.7);
row('prices', 'EUR/USD (ECB)', M.eurusd && M.eurusd.value, fx['EUR/USD'], 'Twelve Data live', 0.5);

// ════════ Screen 4 — breadth: a sample of stocks, checked from scratch ════════
const smas = snap.breadthSMA || {};
const sample = Object.keys(smas).filter(k => isFinite(smas[k].v)).sort(() => 0.5 - Math.random()).slice(0, 12);
console.log(`\nbreadth: ${JSON.stringify(snap.breadth)}`);
let agree = 0, checked = 0;
for (const sym of sample) {
  const h = await safe('nasdaq ' + sym, () => nqHist(sym.replace('.', '/'), 'stocks', from));
  if (!h || h.length < 200) { console.log(`  ${sym}: no independent history (${h ? h.length : 0} days)`); continue; }
  const asc = h.slice().reverse();
  const sma200 = asc.slice(-200).reduce((a, x) => a + x.close, 0) / 200;
  const q = await safe('finnhub ' + sym, () => json(FH(sym)));
  const ours = smas[sym].v, price = q && q.c;
  const sideOurs = price > ours, sideRef = price > sma200;
  checked++; if (sideOurs === sideRef) agree++;
  console.log(`  ${sym.padEnd(6)} price ${price}  avg ours ${ours.toFixed(2)} (${smas[sym].t})  avg independent ${sma200.toFixed(2)}  diff ${pct(ours, sma200).toFixed(2)}%  ${sideOurs === sideRef ? 'same side' : 'DIFFERENT SIDE'}`);
}
console.log(`  sample: ${agree}/${checked} on the same side of the line`);

// ════════ Summary ════════
console.log('\n================ SUMMARY ================');
for (const r of rows) console.log(`${r.verdict.padEnd(8)} ${r.screen.padEnd(11)} ${r.item.padEnd(44)} shown ${String(r.shown).padEnd(12)} ref ${String(r.ref).padEnd(12)} ${String(r.diffPct).padStart(8)}%  ${r.refName}${r.note ? ' — ' + r.note : ''}`);
