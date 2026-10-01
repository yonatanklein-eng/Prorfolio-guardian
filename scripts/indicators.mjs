// Pure computations behind the macro cards, kept apart from the collector so
// they can be tested without running a collection.

export const MONTH_IDX = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

// multpl's by-month table. Value cells carry an &#x2002; entity: decode
// entities before reading the number, or its "2002" ends up glued to the front.
export function parseMultplTable(html) {
  const rows = [];
  const re = /<tr[^>]*>\s*<td[^>]*>\s*([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    if (MONTH_IDX[m[1]] == null) continue;
    const cell = m[4].replace(/&#x?[0-9a-f]+;/gi, ' ').replace(/&[a-z]+;/gi, ' ').replace(/<[^>]+>/g, ' ');
    const num = cell.match(/-?\d+(\.\d+)?/);
    if (!num) continue;
    const date = new Date(Date.UTC(+m[3], MONTH_IDX[m[1]], +m[2])).toISOString().slice(0, 10);
    rows.push({ date, v: parseFloat(num[0]) });
  }
  return rows;   // newest first, as the table lists them
}

// Where today's reading sits in 150 years of them. The first row is the
// current reading; the rest are month starts.
export function capeContext(rows) {
  const [cur, ...months] = rows;
  // A month in progress is not "the past" — skip the current month's row.
  const past = months.filter(r => r.date.slice(0, 7) !== cur.date.slice(0, 7));
  const avg = past.reduce((a, r) => a + r.v, 0) / past.length;
  const pctBelow = past.filter(r => r.v < cur.v).length / past.length;
  // Every past month at least this high, by year. "Highest since <date>" was
  // tried first and read wrong: at 41.0 it said "highest since August 2026",
  // true only because August was higher still. Which years have been here
  // before says what the reader wants to know — at 41, only 1999-2000.
  const atOrAbove = past.filter(r => r.v >= cur.v);
  const peak = past.reduce((a, r) => (r.v > a.v ? r : a), past[0]);
  return {
    value: cur.v, asOf: cur.date,
    avg: +avg.toFixed(1), pctBelow: +pctBelow.toFixed(3),
    atOrAbove: {
      months: atOrAbove.length,
      years: [...new Set(atOrAbove.map(r => +r.date.slice(0, 4)))].sort((a, b) => a - b),
    },
    peak: { value: peak.v, date: peak.date.slice(0, 7) },
    firstYear: past.at(-1).date.slice(0, 4),
  };
}

// DXY is a fixed formula over six exchange rates, with ICE's published weights
// and constant. Given each currency per US dollar (the ECB's quotes rebased to
// USD), a dollar that buys more of a currency raises the index by its weight.
export const DXY_WEIGHTS = { EUR: 0.576, JPY: 0.136, GBP: 0.119, CAD: 0.091, SEK: 0.042, CHF: 0.036 };
export const dxyFromRates = r =>
  50.14348112 * Object.entries(DXY_WEIGHTS).reduce((p, [c, w]) => p * Math.pow(r[c], w), 1);
