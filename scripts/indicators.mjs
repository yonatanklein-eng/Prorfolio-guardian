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

// ── An ETF's fixed ratio to the level it tracks ─────────────────────
// SPY holds the S&P 500 at a nearly constant ratio (about a tenth), moving
// only on dividend days and by its fee, and the same goes for QQQ, DIA and,
// more loosely, USO against WTI. An official close divided by the ETF's close
// for the same day therefore turns a live ETF price into a live level.
//
// "The same day" is the whole difficulty. Finnhub's previous close belongs to
// the trading day before the date of its quote; FRED's newest close can lag a
// day. Only two cases prove a match:
//   - FRED already has the quote's own day: the previous close is then FRED's
//     entry just before it, since FRED lists every trading day;
//   - FRED's newest day is the last weekday before the quote's day.
// Anything else — a holiday between, or FRED behind — returns null, and the
// caller keeps the last good ratio. A ratio a few days old is still right; one
// from the wrong day is off by that day's whole move.

// Calendar date in New York for a unix time — the exchange's trading date.
export function nyDate(s) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(s * 1000)).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}`;
}

export function weekdaysBetween(a, b) {   // strictly between two YYYY-MM-DD dates
  let n = 0;
  const d = new Date(a + 'T12:00:00Z');
  for (d.setUTCDate(d.getUTCDate() + 1); d.toISOString().slice(0, 10) < b; d.setUTCDate(d.getUTCDate() + 1)) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// obs: official closes [{date, v}], oldest first. quote: Finnhub's previous
// close and the unix time of its quote.
export function alignedRatio(obs, prevClose, quoteTime) {
  if (!obs.length || !(prevClose > 0) || !quoteTime) return null;
  const day = nyDate(quoteTime);
  const last = obs.at(-1);
  let match = null;
  if (last.date === day) match = obs.at(-2) || null;
  else if (last.date < day && weekdaysBetween(last.date, day) === 0) match = last;
  if (!match || !(match.v > 0)) return null;
  return { ratio: match.v / prevClose, date: match.date };
}

// ── The yield curve, judged by monthly averages ─────────────────────
// The 10-year minus 3-month spread dips a few hundredths below zero and back
// without meaning anything. Counted day by day — and on the weekly sample the
// page's chart uses — the number of "inversions" changed between runs with
// nothing in the market changing: 4 on 25 Sep, 6 on 1 Oct, from the same
// history sampled on different weekdays. The New York Fed's recession model
// works from the monthly average, so do that: an inversion is a run of whole
// months whose average spread is below zero. The month in progress is not
// judged until it ends; today's daily spread speaks for the present.
//
// ten, three: daily observations [{date, v}], oldest first.
export function curveStats(ten, three) {
  const t3 = new Map(three.map(o => [o.date, o.v]));
  const daily = ten.filter(o => t3.has(o.date)).map(o => ({ date: o.date, v: +(o.v - t3.get(o.date)).toFixed(2) }));
  if (daily.length < 60) return null;
  const months = [];
  for (const o of daily) {
    const key = o.date.slice(0, 7);
    if (!months.length || months.at(-1).month !== key) months.push({ month: key, sum: 0, n: 0, min: Infinity, minDate: null, first: o.date });
    const m = months.at(-1);
    m.sum += o.v; m.n++;
    if (o.v < m.min) { m.min = o.v; m.minDate = o.date; }
  }
  const complete = months.slice(0, -1);
  const episodes = [];
  let open = false;
  for (const m of complete) {
    if (m.sum / m.n < 0) {
      if (open) {
        const e = episodes.at(-1);
        e.to = m.month;
        if (m.min < e.trough) { e.trough = m.min; e.troughDate = m.minDate; }
      } else {
        episodes.push({ from: m.month, to: m.month, trough: m.min, troughDate: m.minDate });
        open = true;
      }
    } else open = false;
  }
  const last = episodes.at(-1);
  // Back above zero: the first trading day of the first month after the last
  // inverted one. Null while that month has not started.
  const after = last ? months.find(m => m.month > last.to) : null;
  const deepest = episodes.reduce((a, e) => (!a || e.trough < a.trough ? e : a), null);
  return {
    current: daily.at(-1).v, asOf: daily.at(-1).date, windowStart: daily[0].date,
    inversions: episodes.length,
    trough: deepest ? deepest.trough : null, troughDate: deepest ? deepest.troughDate : null,
    lastFrom: last ? last.from : null, lastTo: last ? last.to : null,
    uninverted: after ? after.first : null,
  };
}
