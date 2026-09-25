/**
 * One-off: can a GitHub runner reach free sources for the four indicators the
 * page still hardcodes, and what shape is each answer? (The dev sandbox can
 * reach none of these hosts, so this has to run here.)
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/122 Safari/537.36';
const get = (url, opts = {}) => fetch(url, { headers: { 'User-Agent': UA, ...(opts.headers || {}) },
                                             signal: AbortSignal.timeout(25000) });
const section = t => console.log(`\n===== ${t} =====`);

// 1. CAPE — multpl monthly table
section('multpl CAPE');
try {
  const res = await get('https://www.multpl.com/shiller-pe/table/by-month');
  const html = await res.text();
  console.log(`HTTP ${res.status}, ${html.length} bytes`);
  const rows = [];
  const re = /<tr[^>]*>\s*<td[^>]*>\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const cell = m[2].replace(/&#x?[0-9a-f]+;/gi, ' ').replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, ' ');
    const num = cell.match(/-?\d+(\.\d+)?/);
    if (num) rows.push({ d: m[1], v: parseFloat(num[0]), raw: m[2].replace(/\s+/g, ' ').slice(0, 120) });
  }
  console.log(`rows ${rows.length}; first 3:`, JSON.stringify(rows.slice(0, 3)));
  console.log('last:', JSON.stringify(rows.at(-1)));
  // the page's current-value box, if any
  const cur = html.match(/id="current"[\s\S]{0,400}/);
  console.log('current box:', cur ? cur[0].replace(/\s+/g, ' ').slice(0, 300) : 'none');
} catch (e) { console.log('FAILED', e.message); }

// 2. Concentration — iShares IVV holdings CSV
section('iShares IVV holdings');
try {
  const res = await get('https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf/1467271812596.ajax?fileType=csv&fileName=IVV_holdings&dataType=fund');
  const text = await res.text();
  console.log(`HTTP ${res.status}, ${text.length} bytes, type ${res.headers.get('content-type')}`);
  const lines = text.split(/\r?\n/);
  console.log('first 12 lines:\n' + lines.slice(0, 12).map(l => '  | ' + l.slice(0, 160)).join('\n'));
  console.log('last 4 lines:\n' + lines.slice(-4).map(l => '  | ' + l.slice(0, 160)).join('\n'));
} catch (e) { console.log('FAILED', e.message); }

// 3. Concentration fallback — SSGA SPY daily holdings (xlsx)
section('SSGA SPY holdings xlsx');
try {
  const res = await get('https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx');
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`HTTP ${res.status}, ${buf.length} bytes, type ${res.headers.get('content-type')}, magic ${buf.slice(0, 4).toString('hex')}`);
} catch (e) { console.log('FAILED', e.message); }

// 4. Concentration fallback — slickcharts table
section('slickcharts sp500');
try {
  const res = await get('https://www.slickcharts.com/sp500');
  const html = await res.text();
  console.log(`HTTP ${res.status}, ${html.length} bytes`);
  const rows = [...html.matchAll(/<tr>\s*<td>(\d+)<\/td>\s*<td[^>]*>\s*<a[^>]*>([^<]+)<\/a>[\s\S]*?<td>([\d.]+)%<\/td>/g)].slice(0, 12);
  console.log('rows:', JSON.stringify(rows.map(r => [r[1], r[2], r[3]])));
} catch (e) { console.log('FAILED', e.message); }

// 5. DXY from ECB reference rates via the ICE formula
section('Frankfurter → DXY');
try {
  const from = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
  const res = await get(`https://api.frankfurter.dev/v1/${from}..?base=USD&symbols=EUR,JPY,GBP,CAD,SEK,CHF`);
  const d = await res.json();
  console.log(`HTTP ${res.status}; dates:`, Object.keys(d.rates || {}).join(' '));
  const W = { EUR: 0.576, JPY: 0.136, GBP: 0.119, CAD: 0.091, SEK: 0.042, CHF: 0.036 };
  for (const [date, r] of Object.entries(d.rates || {})) {
    const dxy = 50.14348112 * Object.entries(W).reduce((p, [c, w]) => p * Math.pow(r[c], w), 1);
    console.log(`  ${date}  DXY=${dxy.toFixed(3)}  ${JSON.stringify(r)}`);
  }
} catch (e) { console.log('FAILED', e.message); }

// 6. Savings — FRED PSAVERT
section('FRED PSAVERT');
try {
  const key = process.env.FRED_API_KEY;
  if (!key) throw new Error('no key in env');
  const res = await get(`https://api.stlouisfed.org/fred/series/observations?series_id=PSAVERT&api_key=${key}&file_type=json&sort_order=desc&limit=14`);
  const d = await res.json();
  console.log(`HTTP ${res.status};`, (d.observations || []).map(o => `${o.date}=${o.value}`).join(' '));
} catch (e) { console.log('FAILED', e.message); }
