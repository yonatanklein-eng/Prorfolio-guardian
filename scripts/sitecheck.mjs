// Is the Pages site up, and does it render? Run on a GitHub runner, which can
// reach github.io when the dev sandbox cannot.
import { spawnSync } from 'node:child_process';
const base = 'https://yonatanklein-eng.github.io/Prorfolio-guardian/';
for (const path of ['', 'index.html', 'strategy.js', 'data/market.json']) {
  const url = base + path;
  try {
    const r = await fetch(url + '?check=' + Date.now(), { redirect: 'manual' });
    const body = await r.text();
    console.log(`${r.status} ${url} ${body.length}B cache=${r.headers.get('cache-control')} age=${r.headers.get('age')} modified=${r.headers.get('last-modified')}`);
    if (path === '' || path === 'index.html')
      console.log('  planCard:', body.includes('planCard'), 'days-head:', body.includes('days-head'), 'strategy.js:', body.includes('strategy.js'));
    if (path === 'strategy.js') console.log('  has recent:', body.includes('recent'));
    if (path === 'data/market.json') { const d = JSON.parse(body); console.log('  closes:', d.sp500.closes.length, 'generated:', d.generated); }
  } catch (e) { console.log('ERR', url, e.message); }
}
for (const u of ['https://yonatanklein-eng.github.io/Prorfolio-guardian', 'https://yonatanklein-eng.github.io/prorfolio-guardian/']) {
  try { const r = await fetch(u, { redirect: 'manual' }); console.log(r.status, u, '->', r.headers.get('location')); }
  catch (e) { console.log('ERR', u, e.message); }
}
const chrome = ['google-chrome', 'google-chrome-stable', 'chromium-browser'].find(b => spawnSync('which', [b]).status === 0);
console.log('chrome:', chrome);
if (chrome) {
  const r = spawnSync(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--virtual-time-budget=15000',
    '--enable-logging=stderr', '--v=0', '--window-size=390,1400', '--dump-dom', base + '?check=' + Date.now()],
    { encoding: 'utf8', timeout: 90000 });
  const text = (r.stdout || '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const at = (k, n) => { const i = text.indexOf(k); return i < 0 ? '(not found)' : text.slice(i, i + n); };
  console.log('VERDICT:', at('מצב תיק', 260));
  console.log('PLAN:', at('במניות לפי התוכנית', 420));
  console.log('ERRORBOX:', at('שגיאה', 120));
  console.log('CONSOLE:\n' + (r.stderr || '').split('\n').filter(l => /CONSOLE|Uncaught|SyntaxError|TypeError|ReferenceError/i.test(l)).slice(0, 25).join('\n'));
}
