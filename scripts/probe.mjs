/**
 * One-off: Shiller CAPE monthly values for two windows, from the runner (the
 * dev sandbox cannot reach multpl). Raw rows only — no interpolation.
 *
 * The value cells carry an &#x2002; (en space) entity; stripping tags and then
 * every non-digit left its "2002" glued to the number. Decode entities first.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/122 Safari/537.36';

const res = await fetch('https://www.multpl.com/shiller-pe/table/by-month',
                        { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
const html = await res.text();
console.log(`HTTP ${res.status}, ${html.length} bytes`);

const rows = [];
const re = /<tr[^>]*>\s*<td[^>]*>\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
let m;
while ((m = re.exec(html))) {
  const cell = m[2]
    .replace(/&#x?[0-9a-f]+;/gi, ' ')     // numeric entities, incl. &#x2002;
    .replace(/&[a-z]+;/gi, ' ')           // named entities
    .replace(/<[^>]+>/g, ' ');
  const num = cell.match(/-?\d+(\.\d+)?/);
  if (num) rows.push({ d: m[1], v: parseFloat(num[0]), est: /estimate/i.test(m[2]) });
}
console.log(`parsed ${rows.length} rows; newest: ${rows[0] && rows[0].d} = ${rows[0] && rows[0].v}`);

const pick = re2 => rows.filter(r => re2.test(r.d)).reverse();
for (const r of pick(/199[6-9]|200[0-2]/)) console.log('DOTCOM ' + JSON.stringify(r));
for (const r of pick(/202[3-6]/))          console.log('RECENT ' + JSON.stringify(r));
