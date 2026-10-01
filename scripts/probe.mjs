/**
 * One-off: what can give the page real index and commodity levels, so the
 * price rows stop showing ETF prices (SPY 762 for an S&P at 7,650)?
 * Also: how Finnhub's quote dates its previous close, which decides how a
 * live ETF move can be laid onto an official close.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const get = (url, h = {}) => fetch(url, { headers: { 'User-Agent': UA, ...h }, signal: AbortSignal.timeout(20000) });
const section = t => console.log(`\n===== ${t} =====`);
const ny = s => new Date(s * 1000).toLocaleString('en-US', { timeZone: 'America/New_York' });

section('FRED levels (last 4)');
for (const id of ['SP500', 'NASDAQ100', 'NASDAQCOM', 'DJIA', 'DCOILWTICO', 'DCOILBRENTEU']) {
  try {
    const r = await get(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${process.env.FRED_API_KEY}&file_type=json&sort_order=desc&limit=4`);
    const d = await r.json();
    console.log(id.padEnd(13), r.status, (d.observations || []).map(o => `${o.date}=${o.value}`).join('  ') || JSON.stringify(d).slice(0, 120));
  } catch (e) { console.log(id, 'FAILED', e.message); }
}

section('Finnhub quotes');
for (const s of ['SPY', 'QQQ', 'DIA', 'GLD', 'USO', 'UUP']) {
  try {
    const r = await get(`https://finnhub.io/api/v1/quote?symbol=${s}&token=${process.env.FINNHUB_API_KEY}`);
    const d = await r.json();
    console.log(s.padEnd(4), `c=${d.c} pc=${d.pc} dp=${d.dp} t=${d.t} (${ny(d.t)} NY)`);
  } catch (e) { console.log(s, 'FAILED', e.message); }
}

section('Gold');
const tries = [
  ['spdr GLD archive', 'https://www.spdrgoldshares.com/assets/dynamic/GLD/GLD_US_archive_EN.csv'],
  ['gold-api.com', 'https://api.gold-api.com/price/XAU'],
  ['metals.live', 'https://api.metals.live/v1/spot/gold'],
  ['goldprice.org', 'https://data-asg.goldprice.org/dbXRates/USD'],
  ['twelvedata price', `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${process.env.TWELVEDATA_API_KEY}`],
  ['twelvedata series', `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=1day&outputsize=4&apikey=${process.env.TWELVEDATA_API_KEY}`],
];
for (const [name, url] of tries) {
  try {
    const r = await get(url, { Origin: 'https://yonatanklein-eng.github.io' });
    const text = await r.text();
    const lines = text.split(/\r?\n/);
    console.log(`${name}: HTTP ${r.status}, ${text.length} bytes, type ${r.headers.get('content-type')}, CORS ${r.headers.get('access-control-allow-origin')}`);
    if (name.startsWith('spdr')) {
      lines.slice(0, 8).forEach(l => console.log('   head | ' + l.slice(0, 220)));
      lines.filter(l => l.trim()).slice(-3).forEach(l => console.log('   tail | ' + l.slice(0, 220)));
    } else {
      console.log('   ' + text.slice(0, 300).replace(/\s+/g, ' '));
    }
  } catch (e) { console.log(name, 'FAILED', e.message); }
}
