/**
 * What can a GitHub Actions runner actually reach?
 *
 * The first two runs died on `yahoo 429` from the very first request, with and
 * without a session crumb — GitHub's shared runner ranges are blocked outright.
 * Rather than guess at a replacement, probe the candidates from the runner and
 * let the status codes decide.
 *
 * Read the result by kind, not just pass/fail: 401/403 from a keyed API means
 * REACHABLE and needs a key, which is a very different answer from 429.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/122 Safari/537.36';

async function probe(name, url, opts = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      signal: AbortSignal.timeout(15000),
      redirect: opts.redirect || 'follow',
    });
    const text = (await res.text()).slice(0, 160).replace(/\s+/g, ' ');
    const verdict = res.ok ? 'OK'
                  : res.status === 429 ? 'BLOCKED (rate limited)'
                  : (res.status === 401 || res.status === 403) ? 'REACHABLE (needs key/auth)'
                  : `HTTP ${res.status}`;
    console.log(`${name.padEnd(26)} ${String(res.status).padEnd(4)} ${String(Date.now()-t0).padStart(5)}ms  ${verdict}`);
    if (!res.ok) console.log(`${' '.repeat(28)}${text}`);
    return { name, status: res.status, ok: res.ok };
  } catch (e) {
    console.log(`${name.padEnd(26)} ---  ${String(Date.now()-t0).padStart(5)}ms  FAILED: ${e.message}`);
    return { name, error: e.message };
  }
}

console.log('host reachability from this runner\n');
console.log('name                       code  time     verdict');
console.log('-'.repeat(70));

await probe('yahoo v8 chart (bare)', 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d');
await probe('yahoo query2 chart',    'https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=5d&interval=1d');
await probe('yahoo getcrumb',        'https://query1.finance.yahoo.com/v1/test/getcrumb');
await probe('yahoo fc (cookies)',    'https://fc.yahoo.com/', { redirect: 'manual' });
await probe('stooq csv',             'https://stooq.com/q/d/l/?s=%5Espx&i=d');
await probe('fred (no key)',         'https://api.stlouisfed.org/fred/series/observations?series_id=SP500&file_type=json');
await probe('frankfurter fx',        'https://api.frankfurter.dev/v1/latest?base=USD&symbols=ILS');
await probe('coingecko btc',         'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
await probe('finnhub (no key)',      'https://finnhub.io/api/v1/quote?symbol=SPY');
await probe('twelvedata (no key)',   'https://api.twelvedata.com/time_series?symbol=SPY&interval=1day&outputsize=5');
await probe('alphavantage (demo)',   'https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=IBM&apikey=demo');
await probe('nasdaq screener',       'https://api.nasdaq.com/api/quote/SPY/info?assetclass=etf');

console.log('\ndone');
