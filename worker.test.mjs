import worker, { fredHistory, getHistory } from './worker.js';

// Cloudflare-only global; the router just needs a miss then a put.
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

let plan = {};
globalThis.fetch = async (url) => {
  const u = String(url);
  for (const [frag, resp] of Object.entries(plan)) {
    if (u.includes(frag)) return resp();
  }
  return new Response('nope', { status: 404 });
};

const ORIGIN = 'https://yonatanklein-eng.github.io';
const call = (path) => worker.fetch(new Request('https://w.dev' + path, { headers: { Origin: ORIGIN } }));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}

// ── Yahoo payload with deliberate holes ──
function yahooPayload(n, holes = []) {
  const closes = [], stamps = [];
  let t = 1700000000;
  for (let i = 0; i < n; i++) { closes.push(holes.includes(i) ? null : 100 + i); stamps.push(t + i * 86400); }
  return new Response(JSON.stringify({ chart: { result: [{ timestamp: stamps, indicators: { quote: [{ close: closes }] } }] } }), { status: 200 });
}

function stooqCsv(n) {
  const rows = ['Date,Open,High,Low,Close,Volume'];
  for (let i = 0; i < n; i++) {
    const d = new Date((1700000000 + i * 86400) * 1000).toISOString().slice(0, 10);
    rows.push(`${d},1,2,0,${(200 + i).toFixed(2)},1000`);
  }
  return new Response(rows.join('\n'), { status: 200 });
}

console.log('\n[1] Yahoo history — holes must drop close AND stamp together');
plan = { 'query1.finance.yahoo.com': () => yahooPayload(300, [5, 6, 100]) };
let r = await call('/history?symbol=%5EGSPC&range=300d');
let b = await r.json();
check('source is yahoo', b.source === 'yahoo', b.source);
check('3 holes removed', b.closes.length === 297, b.closes.length);
check('arrays stay aligned', b.closes.length === b.stamps.length);
check('hole index not present', !b.closes.includes(105) && !b.closes.includes(106));
check('stamp for dropped bar also gone', !b.stamps.includes(1700000000 + 5 * 86400));

console.log('\n[2] Yahoo down -> Stooq fallback');
plan = { 'query1.finance.yahoo.com': () => new Response('err', { status: 500 }), 'stooq.com': () => stooqCsv(300) };
r = await call('/history?symbol=%5EGSPC&range=300d');
b = await r.json();
check('fell through to stooq', b.source === 'stooq', b.source);
check('parsed 300 rows', b.closes.length === 300, b.closes.length);
check('close parsed as number', b.closes[0] === 200, b.closes[0]);
check('date parsed to epoch seconds', b.stamps[0] === 1699920000, b.stamps[0]);

console.log('\n[3] Both upstreams down -> 502, not a cached lie');
plan = { 'query1.finance.yahoo.com': () => new Response('x', { status: 500 }), 'stooq.com': () => new Response('x', { status: 500 }) };
r = await call('/history?symbol=%5EGSPC');
check('status 502', r.status === 502, r.status);
check('error body present', (await r.json()).error.includes('all upstreams failed'));

console.log('\n[4] /quote derives change from the last two closes');
plan = { 'query1.finance.yahoo.com': () => yahooPayload(5) };
r = await call('/quote?symbol=%5EGSPC');
b = await r.json();
check('price = last close', b.price === 104, b.price);
check('prevClose = one before', b.prevClose === 103, b.prevClose);
check('change ~ +0.97%', Math.abs(b.change - 0.970873) < 1e-4, b.change);

// ^S5TH is a percentage series, so mock it as one
function pctPayload(v) {
  return new Response(JSON.stringify({ chart: { result: [{
    timestamp: [1700000000, 1700086400], indicators: { quote: [{ close: [v - 1, v] }] } }] } }), { status: 200 });
}

console.log('\n[5] /breadth prefers the ready-made index');
plan = { '%5ES5TH': () => pctPayload(62), 'query1.finance.yahoo.com': () => yahooPayload(300) };
r = await call('/breadth');
b = await r.json();
check('used the index, not a scan', b.method === 'index:^S5TH', b.method);
check('breadth is the index value', b.breadth === 62, b.breadth);

console.log('\n[6] index missing -> sample, and it must say so');
plan = {
  '%5ES5TH': () => new Response('no', { status: 404 }),
  'query1.finance.yahoo.com': () => yahooPayload(300),
  'stooq.com': () => stooqCsv(300),
};
r = await call('/breadth');
b = await r.json();
check('method labels itself a sample', /^sample:\d+$/.test(b.method || ''), b.method);
check('counted is reported', b.counted > 25, b.counted);
check('breadth is a percentage', b.breadth >= 0 && b.breadth <= 100, b.breadth);
check('records why the index failed', !!b.indexError);

console.log('\n[6b] an out-of-range "percentage" must be refused, not published');
plan = {
  '%5ES5TH': () => pctPayload(499),          // upstream served the wrong series
  'query1.finance.yahoo.com': () => yahooPayload(300),
  'stooq.com': () => stooqCsv(300),
};
r = await call('/breadth');
b = await r.json();
check('did not publish 499%', b.breadth !== 499, b.breadth);
check('fell back to the sample', /^sample:/.test(b.method || ''), b.method);
check('says the index value was implausible', /implausible/.test(b.indexError || ''), b.indexError);
check('result is a real percentage', b.breadth >= 0 && b.breadth <= 100, b.breadth);

console.log('\n[8] FRED fallback when Yahoo is down');
process.env.FRED_API_KEY = 'TESTKEY';
plan = {
  'query1.finance.yahoo.com': () => new Response('x', { status: 500 }),
  'api.stlouisfed.org': () => new Response(JSON.stringify({ observations: [
      ...Array.from({length: 40}, (_, i) => ({ date: `2026-0${1 + (i % 9)}-0${1 + (i % 9)}`, value: String(4000 + i) })),
      { date: '2026-09-15', value: '.' },        // FRED marks missing days with a dot
    ]}), { status: 200 }),
  'stooq.com': () => new Response('x', { status: 500 }),
};
r = await call('/history?symbol=%5EGSPC&range=300d');
b = await r.json();
check('source is fred', b.source === 'fred', b.source);
check('dot rows dropped', !b.closes.some(c => Number.isNaN(c)), b.closes.slice(-3));
check('closes and stamps aligned', b.closes.length === b.stamps.length);

console.log('\n[8b] no FRED key -> that upstream is skipped, not crashed on');
delete process.env.FRED_API_KEY;
let threw = null;
try { await fredHistory('^GSPC', 30); } catch (e) { threw = e.message; }
check('fails with a clear reason', /no api key/.test(threw || ''), threw);
check('unmapped symbol refused too', await fredHistory('NVDA', 30).then(() => false, e => /no series/.test(e.message)));

console.log('\n[9] Stooq answering with its API-key page must not parse as data');
plan = {
  'query1.finance.yahoo.com': () => new Response('x', { status: 500 }),
  // what stooq.com actually returns without a key since early 2026
  'stooq.com': () => new Response('<html><body>To download data you need an API key...</body></html>', { status: 200 }),
};
r = await call('/history?symbol=%5EGSPC&range=300d');
check('rejected, not treated as a series', r.status === 502, r.status);
check('error names the failure', (await r.json()).error.includes('all upstreams failed'));

console.log('\n[7] CORS');
plan = { 'query1.finance.yahoo.com': () => yahooPayload(5) };
r = await call('/quote?symbol=X');
check('echoes the allowed origin', r.headers.get('access-control-allow-origin') === ORIGIN, r.headers.get('access-control-allow-origin'));
check('varies on Origin', r.headers.get('vary') === 'Origin');
const pre = await worker.fetch(new Request('https://w.dev/quote', { method: 'OPTIONS', headers: { Origin: ORIGIN } }));
check('preflight answered', pre.status === 200 && !!pre.headers.get('access-control-allow-origin'));

const unknown = await worker.fetch(new Request('https://w.dev/quote?symbol=X', { headers: { Origin: 'https://evil.example' } }));
check('unknown origin not echoed back', unknown.headers.get('access-control-allow-origin') !== 'https://evil.example',
      unknown.headers.get('access-control-allow-origin'));

// ── The four macro readings that used to be constants ──
const { parseMultplTable, capeContext, dxyFromRates } = await import('./scripts/indicators.mjs');
const { readFirstSheet } = await import('./scripts/xlsx.mjs');
const { concentrationFromRows } = await import('./scripts/holdings.mjs');
const { deflateRawSync } = await import('node:zlib');

console.log('\n[10] CAPE from multpl');
const multplRow = (d, v) => `<tr><td class="left">${d}</td><td class="right">&#x2002;${v}\n</td></tr>`;
const capeRows = parseMultplTable('<table>' + [
  multplRow('Sep 24, 2026', '41.25'), multplRow('Sep 1, 2026', '41.90'), multplRow('Aug 1, 2026', '41.13'),
  multplRow('Aug 1, 2000', '41.40'), multplRow('Dec 1, 1999', '44.19'), multplRow('Jan 1, 1990', '17.05'),
].join('') + '</table>');
check('the &#x2002; entity does not leak into the number', capeRows[0].v === 41.25, capeRows[0]);
check('dates read as UTC days, newest first', capeRows[0].date === '2026-09-24' && capeRows.at(-1).date === '1990-01-01');
const ctx = capeContext(capeRows);
check('"highest since" skips the month in progress', ctx.highestSince === '2000-08', ctx.highestSince);
check('peak and share below come from past months', ctx.peak.value === 44.19 && ctx.peak.date === '1999-12' && ctx.pctBelow === 0.5, ctx);
check('a new high has no "since"', capeContext(parseMultplTable(multplRow('Sep 24, 2026', '50') + multplRow('Dec 1, 1999', '44.19'))).highestSince === null);

console.log('\n[11] DXY from ECB rates');
// ECB rates for 2026-09-25 as the runner received them
const r925 = { CAD: 1.4143, CHF: 0.82829, EUR: 0.87696, GBP: 0.75458, JPY: 157.59, SEK: 9.9009 };
check('ICE formula on real rates lands on the DXY scale', Math.abs(dxyFromRates(r925) - 100.984) < 0.01, dxyFromRates(r925));
const eurUp = { ...r925, EUR: r925.EUR * 1.01 };   // a dollar that buys 1% more euros
check('the euro carries its 57.6% weight', Math.abs(dxyFromRates(eurUp) / dxyFromRates(r925) - Math.pow(1.01, 0.576)) < 1e-12);

console.log('\n[12] SPY holdings (.xlsx)');
// A minimal zip: one stored part and one deflated, which is all the reader needs.
function zip(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, text, deflate] of files) {
    const raw = Buffer.from(text), data = deflate ? deflateRawSync(raw) : raw, nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nm, data); centrals.push(ch, nm);
    offset += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const strings = ['Holdings:', 'As of 29-Sep-2026', 'Ticker', 'Weight', 'AT&T INC'];
const sst = '<sst>' + strings.map(s => `<si><t>${s.replace('&', '&amp;')}</t></si>`).join('')
  + '<si><r><t>Rich </t></r><r><t>text</t></r></si></sst>';
const holding = (i, t, w) => `<row r="${i}"><c r="A${i}" t="inlineStr"><is><t>${t}</t></is></c><c r="B${i}"><v>${w}</v></c></row>`;
let sheetRows = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>'
  + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2" s="1"/><c r="D2" t="s"><v>5</v></c></row>';
const big = [['NVDA', 8], ['AAPL', 7], ['MSFT', 6], ['GOOGL', 3], ['GOOG', 2.5], ['AMZN', 4], ['AVGO', 2.6],
             ['META', 2.4], ['MU', 1.8], ['TSLA', 1.5], ['AMD', 1.4]];
const restW = (100 - big.reduce((a, [, w]) => a + w, 0)) / 490;
let rowNo = 3;
for (const [t, w] of big) sheetRows += holding(rowNo++, t, w);
for (let i = 0; i < 490; i++) sheetRows += holding(rowNo++, 'Q' + String.fromCharCode(65 + Math.floor(i / 26) % 26, 65 + i % 26), restW);
sheetRows += holding(rowNo++, 'CASH_USD', 0.1);
const book = zip([['xl/sharedStrings.xml', sst, false], ['xl/worksheets/sheet1.xml', `<worksheet><sheetData>${sheetRows}</sheetData></worksheet>`, true]]);
const sheet = readFirstSheet(book);
check('shared, inline and rich-text strings all read', sheet[0][1] === 'As of 29-Sep-2026' && sheet[2][0] === 'NVDA' && sheet[1][3] === 'Rich text', sheet.slice(0, 3));
check('a self-closing cell keeps the columns aligned', sheet[1].length === 4 && sheet[1][2] === '');
const conc = concentrationFromRows(sheet);
check('Alphabet counted once across both share classes', conc.top.find(c => c.ticker === 'GOOGL').weight === 5.5 && !conc.top.some(c => c.ticker === 'GOOG'), conc.top);
check('top ten summed after merging, cash ignored', conc.top10 === 40.2 && conc.holdings === 501, conc);
check('the as-of date comes from the header', conc.asOf === '2026-09-29', conc.asOf);
let cutShort = null;
try { concentrationFromRows(sheet.slice(0, 40)); } catch (e) { cutShort = e.message; }
check('a file cut short is refused, not summed', /stocks/.test(cutShort || ''), cutShort);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
