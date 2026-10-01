// How much of the S&P 500 its ten largest companies make up, from the daily
// holdings file of SPY, the oldest ETF on the index. SPY holds every member at
// its index weight, so its weights are the index's.
//
// Other places to get this were tried from the runner first: iShares' IVV
// holdings link answers with a web page rather than the CSV, and Slickcharts
// answers 403. State Street's file is an .xlsx, hence xlsx.mjs.
import { readFirstSheet } from './xlsx.mjs';

export const SPY_HOLDINGS_URL =
  'https://www.ssga.com/us/en/intermediary/library-content/products/fund-data/etfs/us/holdings-daily-us-en-spy.xlsx';

// Share classes of one company. Concentration is about companies: Alphabet is
// one bet whether its weight sits in GOOGL, GOOG or both.
const SAME_COMPANY = { GOOG: 'GOOGL', FOX: 'FOXA', NWS: 'NWSA' };

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

export function concentrationFromRows(rows) {
  const head = rows.findIndex(r => r.some(c => /^ticker$/i.test(c.trim())) && r.some(c => /^weight/i.test(c.trim())));
  if (head < 0) throw new Error('holdings: no Ticker/Weight header');
  const iT = rows[head].findIndex(c => /^ticker$/i.test(c.trim()));
  const iW = rows[head].findIndex(c => /^weight/i.test(c.trim()));

  // "Holdings: As of 24-Sep-2026", somewhere above the table
  let asOf = null;
  for (const r of rows.slice(0, head)) {
    const m = /as of\s+(\d{1,2})-([a-z]{3})-(\d{4})/i.exec(r.join(' '));
    if (m && MONTHS[m[2].toLowerCase()] != null) {
      asOf = new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1])).toISOString().slice(0, 10);
      break;
    }
  }

  const byCompany = {};
  let count = 0;
  for (const r of rows.slice(head + 1)) {
    const t = (r[iT] || '').trim().toUpperCase();
    const w = parseFloat(r[iW]);
    // Stocks only: cash lines, futures and the disclaimer text below the
    // table have no ticker of this shape, or no weight.
    if (!/^[A-Z]{1,5}([./][A-Z])?$/.test(t) || !isFinite(w) || w <= 0) continue;
    const k = SAME_COMPANY[t] || t;
    byCompany[k] = (byCompany[k] || 0) + w;
    count++;
  }
  let total = Object.values(byCompany).reduce((a, b) => a + b, 0);
  // Weights are percentages; a file that gave fractions would sum to ~1.
  const scale = total > 0 && total < 2 ? 100 : 1;
  total *= scale;
  if (count < 450 || count > 550) throw new Error(`holdings: ${count} stocks`);
  if (total < 95 || total > 101) throw new Error(`holdings: weights sum to ${total.toFixed(1)}%`);

  const top = Object.entries(byCompany)
    .map(([ticker, w]) => ({ ticker, weight: +(w * scale).toFixed(2) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 10);
  const top10 = +top.reduce((a, c) => a + c.weight, 0).toFixed(1);
  return { top10, largest: top[0], top, holdings: count, asOf };
}

export async function fetchConcentration() {
  const res = await fetch(SPY_HOLDINGS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('ssga ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  return concentrationFromRows(readFirstSheet(buf));
}
