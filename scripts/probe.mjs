/**
 * Follow-up audit: the S&P 500's 200-day line from an independent angle, gaps
 * in FRED's daily series, the ECB rates behind EUR/USD's 0.00% change, and
 * the shape of CBOE's VIX file.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const get = (url, h = {}) => fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...h }, signal: AbortSignal.timeout(25000) });
const json = async (url, h) => { const r = await get(url, h); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const snap = await json(`https://raw.githubusercontent.com/yonatanklein-eng/Prorfolio-guardian/main/data/market.json?x=${Date.now()}`);

// 1. The trading calendar from Nasdaq's Composite history, against FRED's S&P days
const from = new Date(Date.now() - 420 * 86400000).toISOString().slice(0, 10);
try {
  const d = await json(`https://api.nasdaq.com/api/quote/COMP/historical?assetclass=index&fromdate=${from}&limit=400`,
                       { Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' });
  const days = (d.data.tradesTable.rows || []).map(r => { const [m, dd, y] = r.date.split('/'); return `${y}-${m}-${dd}`; });
  const ours = new Set(snap.sp500.stamps.map(s => new Date(s * 1000).toISOString().slice(0, 10)));
  const first = [...ours].sort()[0];
  const missing = days.filter(x => x >= first && !ours.has(x));
  console.log(`trading days since ${first}: ${days.filter(x => x >= first).length}; in FRED S&P series: ${ours.size}; missing: ${missing.length} ${missing.slice(0, 12).join(' ')}`);
} catch (e) { console.log('calendar check failed:', e.message); }

// 2. SPY's own 200-day average times the S&P/SPY ratio, against ours
const closes = snap.sp500.closes;
const ours = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
try {
  const s = await json(`https://api.twelvedata.com/sma?symbol=SPY&interval=1day&time_period=200&series_type=close&outputsize=1&apikey=${process.env.TWELVEDATA_API_KEY}`);
  const spySma = parseFloat(s.values[0].sma);
  const r = snap.levels.sp500.ratio;
  console.log(`S&P SMA200 ours ${ours.toFixed(2)}; SPY SMA200 ${spySma} x ratio ${r.toFixed(4)} = ${(spySma * r).toFixed(2)}  (diff ${((ours / (spySma * r) - 1) * 100).toFixed(3)}%, SPY's dividends move the ratio ~1%/yr)`);
} catch (e) { console.log('SPY SMA failed:', e.message); }

// 3. The ECB rates behind the FX rows
const fromFx = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
for (const sym of ['EUR', 'ILS']) {
  try {
    const d = await json(`https://api.frankfurter.dev/v1/${fromFx}..?base=USD&symbols=${sym}`);
    console.log(`frankfurter ${sym}:`, Object.entries(d.rates).map(([k, v]) => `${k}=${v[sym]}`).join('  '));
  } catch (e) { console.log(`frankfurter ${sym} failed:`, e.message); }
}
console.log('snapshot eurusd', JSON.stringify(snap.macro.eurusd), 'usdils', JSON.stringify(snap.macro.usdils));

// 4. CBOE's VIX file, last rows
try {
  const t = await (await get('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv')).text();
  const L = t.trim().split('\n');
  console.log('cboe VIX header:', L[0], '| last 3:', L.slice(-3).join(' | '));
} catch (e) { console.log('cboe failed:', e.message); }
