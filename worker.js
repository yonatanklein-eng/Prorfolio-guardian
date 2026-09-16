/**
 * שומר התיק — data proxy (Cloudflare Worker)
 *
 * Why this exists: the app is a static page, so every request it makes is
 * subject to CORS, and none of the free market-data providers reliably allow
 * browser origins. Server-side there is no CORS at all, so this Worker can
 * read whichever upstream is healthy and hand the result back with headers
 * the page is allowed to read.
 *
 * It also caches. The 200-day history moves once a day, so one upstream fetch
 * serves every visitor instead of one per page load.
 *
 * Deploy: dash.cloudflare.com -> Workers & Pages -> Create -> paste this ->
 * Deploy. Then open the app, page 2, and paste the *.workers.dev URL.
 *
 * Endpoints:
 *   /history?symbol=^GSPC&range=300d  -> {closes:[], stamps:[], source}
 *   /quote?symbol=^GSPC               -> {price, prevClose, change, source}
 *   /breadth                          -> {breadth, above, counted, method}
 */

// Only these origins may read responses. Add your own before deploying.
const ALLOWED = [
  'https://yonatanklein-eng.github.io',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const CACHE_HISTORY = 60 * 60 * 6;   // 6h  — daily bars change once a day
const CACHE_QUOTE   = 60;            // 60s — matches the app's refresh cycle
const CACHE_BREADTH = 60 * 60 * 12;  // 12h — a breadth reading is a daily stat

function cors(origin) {
  const allow = ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(body, origin, maxAge) {
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
      ...cors(origin),
    },
  });
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

// ── Upstream 1: Yahoo ────────────────────────────────────────────────
async function yahooHistory(symbol, range, minBars = 30) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/`
    + `${encodeURIComponent(symbol)}?range=${range}&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error('yahoo ' + res.status);
  const data = await res.json();
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error('yahoo: empty result');

  // Closes and timestamps must stay aligned — filtering one without the other
  // silently shifts every date in the series.
  const rawC = r.indicators?.quote?.[0]?.close || [];
  const rawT = r.timestamp || [];
  const closes = [], stamps = [];
  rawC.forEach((c, i) => { if (c != null && rawT[i] != null) { closes.push(c); stamps.push(rawT[i]); } });
  if (closes.length < minBars) throw new Error('yahoo: series too short');
  return { closes, stamps, source: 'yahoo' };
}

// ── Yahoo batch quotes ───────────────────────────────────────────────
// v7/finance/quote takes up to 50 symbols per call and returns a ready-made
// twoHundredDayAverage field. That is the whole breadth calculation for 500
// names in ten requests and a few seconds — no history downloads, no scan.
//
// It needs a session crumb, which is what broke the client libraries in 2024:
// fetch cookies from Yahoo, trade them for a crumb, then send both. The crumb
// is good for a while, so cache it.
let crumbCache = null;

function readSetCookie(res) {
  const h = res.headers;
  const all = typeof h.getSetCookie === 'function' ? h.getSetCookie() : null;
  if (all && all.length) return all.map(c => c.split(';')[0]).join('; ');
  const one = h.get('set-cookie');
  return one ? one.split(';')[0] : '';
}

async function yahooCrumb() {
  if (crumbCache && Date.now() - crumbCache.t < 25 * 60 * 1000) return crumbCache;

  const r1 = await fetch('https://fc.yahoo.com/', {
    headers: { 'User-Agent': UA }, redirect: 'manual',
  });
  const cookie = readSetCookie(r1);
  if (!cookie) throw new Error('yahoo: no session cookie');

  const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'text/plain' },
  });
  if (!r2.ok) throw new Error('yahoo crumb ' + r2.status);
  const crumb = (await r2.text()).trim();
  // A real crumb is a short opaque token; an error page is neither short nor opaque.
  if (!crumb || crumb.length > 40 || crumb.includes('<')) throw new Error('yahoo: bad crumb');

  crumbCache = { crumb, cookie, t: Date.now() };
  return crumbCache;
}

// Returns one row per symbol that answered. Symbols Yahoo does not know are
// simply absent, so callers must count what came back rather than assume.
export async function yahooQuoteBatch(symbols) {
  const { crumb, cookie } = await yahooCrumb();
  const url = 'https://query1.finance.yahoo.com/v7/finance/quote'
    + `?symbols=${symbols.map(encodeURIComponent).join(',')}`
    + '&fields=symbol,regularMarketPrice,twoHundredDayAverage,regularMarketChangePercent'
    + `&crumb=${encodeURIComponent(crumb)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'application/json' },
  });
  if (res.status === 401 || res.status === 403) {
    crumbCache = null;                       // stale crumb; let the caller retry
    throw new Error('yahoo quote ' + res.status + ' (crumb rejected)');
  }
  if (!res.ok) throw new Error('yahoo quote ' + res.status);
  const d = await res.json();
  const rows = d && d.quoteResponse && d.quoteResponse.result;
  if (!Array.isArray(rows)) throw new Error('yahoo quote: unexpected shape');
  return rows;
}

// ── Upstream 2: FRED (Federal Reserve Bank of St. Louis) ─────────────
// Official, stable, and free with a key. No CORS headers, which does not
// matter: this only ever runs server-side.
//
// This replaced Stooq, which stopped serving CSV without an emailed API key
// in early 2026 and now returns an instructions page instead
// (pydata/pandas-datareader#1012).
const FRED_MAP = {
  '^GSPC':     'SP500',
  '^VIX':      'VIXCLS',
  '^TNX':      'DGS10',
  '^IRX':      'DGS3MO',
  '^TYX':      'DGS30',
  'CL=F':      'DCOILWTICO',
  'DX-Y.NYB':  'DTWEXBGS',
};

async function fredHistory(symbol, minBars = 30, key = null) {
  const series = FRED_MAP[symbol];
  if (!series) throw new Error('fred: no series for ' + symbol);
  const apiKey = key || (typeof process !== 'undefined' && process.env && process.env.FRED_API_KEY);
  if (!apiKey) throw new Error('fred: no api key');

  const start = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  const url = `https://api.stlouisfed.org/fred/series/observations`
    + `?series_id=${series}&api_key=${apiKey}&file_type=json&observation_start=${start}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('fred ' + res.status);
  const data = await res.json();

  const closes = [], stamps = [];
  for (const o of data.observations || []) {
    const v = parseFloat(o.value);          // FRED writes "." for missing days
    const t = Date.parse(o.date + 'T00:00:00Z') / 1000;
    if (isFinite(v) && isFinite(t)) { closes.push(v); stamps.push(t); }
  }
  if (closes.length < minBars) throw new Error('fred: series too short');
  return { closes, stamps, source: 'fred' };
}

// ── Upstream 3: Stooq ────────────────────────────────────────────────
// Kept last and expected to fail: since early 2026 Stooq answers without a
// key by returning an HTML instructions page, which the header check below
// rejects. Left in place because it costs nothing and still works for anyone
// who has a key.
const STOOQ_MAP = { '^GSPC': '^spx', '^IXIC': '^ndq', '^DJI': '^dji', '^VIX': '^vix' };

async function stooqHistory(symbol, minBars = 30) {
  const s = STOOQ_MAP[symbol] || (symbol.startsWith('^') ? symbol.toLowerCase() : symbol.toLowerCase() + '.us');
  const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`,
                          { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('stooq ' + res.status);
  const text = await res.text();
  const lines = text.trim().split('\n');
  if (lines.length <= minBars || !lines[0].toLowerCase().startsWith('date')) throw new Error('stooq: not a series');

  const closes = [], stamps = [];
  const cols = lines[0].split(',').map(h => h.trim().toLowerCase());
  const iDate = cols.indexOf('date'), iClose = cols.indexOf('close');
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    const c = parseFloat(p[iClose]);
    const t = Date.parse(p[iDate] + 'T00:00:00Z') / 1000;
    if (isFinite(c) && isFinite(t)) { closes.push(c); stamps.push(t); }
  }
  if (closes.length < minBars) throw new Error('stooq: series too short');
  return { closes, stamps, source: 'stooq' };
}

export { fredHistory, yahooHistory, stooqHistory };

export async function getHistory(symbol, range, minBars = 30) {
  const errs = [];
  for (const fn of [
    () => yahooHistory(symbol, range, minBars),
    () => fredHistory(symbol, minBars),
    () => stooqHistory(symbol, minBars),
  ]) {
    try { return await fn(); } catch (e) { errs.push(e.message); }
  }
  throw new Error('all upstreams failed: ' + errs.join(' | '));
}

// ── Breadth ──────────────────────────────────────────────────────────
// The Workers free plan caps subrequests at 50 per request, so a 500-stock
// census is off the table here. ^S5TH is the same statistic published as an
// index — one request — and the sample is only the fallback.
export const SAMPLE = [
  'AAPL','MSFT','NVDA','AMZN','GOOGL','META','BRK-B','LLY','AVGO','JPM',
  'XOM','UNH','V','PG','MA','HD','COST','MRK','ABBV','CVX',
  'PEP','KO','ADBE','WMT','CRM','MCD','CSCO','ACN','TMO','ABT',
  'LIN','DHR','INTC','VZ','CMCSA','NKE','PM','TXN','NEE','RTX',
  'HON','UNP','LOW','SPGI','CAT'
];

export async function breadthFromIndex() {
  const { closes } = await getHistory('^S5TH', '5d', 2);
  const v = closes[closes.length - 1];
  // ^S5TH is a percentage by definition. Anything outside 0-100 means we were
  // served some other series, and publishing it would put a confident,
  // meaningless number on the page — refuse and let the sample take over.
  if (!isFinite(v) || v < 0 || v > 100) throw new Error(`S5TH: implausible value ${v}`);
  return { breadth: Math.round(v), above: null, counted: 503, method: 'index:^S5TH' };
}

export async function breadthFromSample() {
  let above = 0, counted = 0;
  const settled = await Promise.allSettled(SAMPLE.map(s => getHistory(s, '300d')));
  settled.forEach(r => {
    if (r.status !== 'fulfilled') return;
    const c = r.value.closes;
    if (c.length < 200) return;
    const sma = c.slice(-200).reduce((a, b) => a + b, 0) / 200;
    counted++;
    if (c[c.length - 1] > sma) above++;
  });
  if (counted < 25) throw new Error(`sample too small (${counted})`);
  return {
    breadth: Math.round((above / counted) * 100),
    above, counted,
    method: `sample:${counted}`,   // the page must show this — it is not a census
  };
}

// ── Router ───────────────────────────────────────────────────────────
export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });

    const url = new URL(request.url);
    const cache = caches.default;
    const hit = await cache.match(request);
    if (hit) return hit;

    let res;
    try {
      if (url.pathname === '/history') {
        const symbol = url.searchParams.get('symbol') || '^GSPC';
        const range = url.searchParams.get('range') || '300d';
        res = json(await getHistory(symbol, range), origin, CACHE_HISTORY);

      } else if (url.pathname === '/quote') {
        const symbol = url.searchParams.get('symbol') || '^GSPC';
        const { closes, stamps, source } = await getHistory(symbol, '5d', 2);
        const price = closes[closes.length - 1];
        const prevClose = closes[closes.length - 2];
        res = json({
          price, prevClose,
          change: prevClose ? ((price - prevClose) / prevClose) * 100 : null,
          asOf: stamps[stamps.length - 1], source,
        }, origin, CACHE_QUOTE);

      } else if (url.pathname === '/breadth') {
        let out;
        try { out = await breadthFromIndex(); }
        catch (e) { out = await breadthFromSample(); out.indexError = e.message; }
        res = json(out, origin, CACHE_BREADTH);

      } else {
        res = json({ ok: true, endpoints: ['/history', '/quote', '/breadth'] }, origin, 60);
      }
    } catch (err) {
      // Not cached: a transient upstream failure should not stick around.
      return new Response(JSON.stringify({ error: String(err.message || err) }), {
        status: 502,
        headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) },
      });
    }

    await cache.put(request, res.clone());
    return res;
  },
};
