/**
 * One-off: parse State Street's SPY holdings file from the runner with
 * scripts/xlsx.mjs and holdings.mjs, and show enough of it to check the layout.
 */
import { readFirstSheet } from './xlsx.mjs';
import { SPY_HOLDINGS_URL, concentrationFromRows } from './holdings.mjs';

const res = await fetch(SPY_HOLDINGS_URL, {
  headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36' },
  signal: AbortSignal.timeout(30000),
});
const buf = Buffer.from(await res.arrayBuffer());
console.log(`HTTP ${res.status}, ${buf.length} bytes`);
const rows = readFirstSheet(buf);
console.log(`rows ${rows.length}`);
rows.slice(0, 9).forEach((r, i) => console.log(`  row ${i}: ${JSON.stringify(r)}`));
console.log('  ...');
rows.slice(-6).forEach(r => console.log(`  tail: ${JSON.stringify(r).slice(0, 200)}`));
try { console.log('RESULT', JSON.stringify(concentrationFromRows(rows))); }
catch (e) { console.log('PARSE FAILED', e.message); }
