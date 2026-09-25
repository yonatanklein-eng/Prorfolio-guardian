/**
 * One-off: pull Shiller CAPE monthly values for the dot-com run-up, from the
 * runner (the dev sandbox cannot reach these hosts). Prints raw rows only —
 * no interpolation, no estimates.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
         + '(KHTML, like Gecko) Chrome/122 Safari/537.36';

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  console.log(`${url} -> HTTP ${res.status}, ${text.length} bytes`);
  return res.ok ? text : null;
}

// multpl: an HTML table of date / value, newest first.
const html = await get('https://www.multpl.com/shiller-pe/table/by-month');
if (html) {
  const rows = [];
  const re = /<tr[^>]*>\s*<td[^>]*>\s*([A-Z][a-z]{2} \d{1,2}, \d{4})\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = re.exec(html))) {
    const v = parseFloat(m[2].replace(/<[^>]+>/g, '').replace(/[^\d.]/g, ''));
    if (isFinite(v)) rows.push({ date: m[1], v });
  }
  console.log(`parsed ${rows.length} rows\n`);
  const want = rows.filter(r => /199[6-9]|200[0-2]/.test(r.date)).reverse();
  for (const r of want) console.log(`${r.date.padEnd(14)} ${r.v.toFixed(2)}`);
  if (!want.length) console.log(html.slice(0, 1500));
}
