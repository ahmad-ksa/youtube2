// Runs the real built user script at youtube.com/robots.txt, answering network calls from recorded responses.
const { chromium } = require('playwright');
const fs = require('fs');
const rec = JSON.parse(fs.readFileSync(process.argv[2] || 'replay.json', 'utf8'));
const S = process.env.SHOTS || '/tmp';

function keyOf(url, body) {
  const u = new URL(url);
  let k = u.origin + u.pathname;
  if (u.pathname.startsWith('/youtubei/')) {
    try {
      const b = JSON.parse(body || '{}');
      k += '|' + (b.browseId || b.query || b.videoId || b.continuation || '');
    } catch { /* ignore */ }
  } else if (u.pathname.includes('complete')) k += '|' + u.searchParams.get('q');
  return k;
}
const map = new Map();
for (const r of rec) map.set(keyOf(r.url, r.body), r);

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const logs = [];
  p.on('pageerror', (e) => logs.push('PAGEERR ' + e.message));
  p.on('console', (m) => { if (/error|warn/.test(m.type())) logs.push(m.type() + ' ' + m.text().slice(0, 220)); });
  const misses = [];
  await p.route('**/*', async (route) => {
    const req = route.request(); const url = req.url();
    if (url === 'https://www.youtube.com/robots.txt' || url.startsWith('https://www.youtube.com/robots.txt#')) return route.fulfill({ status: 200, contentType: 'text/plain', body: 'User-agent: *' });
    if (/i\.ytimg\.com|yt3\.|ggpht/.test(url)) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#345"/></svg>' });
    const r = map.get(keyOf(url, req.postData()));
    if (r) return route.fulfill({ status: r.status, contentType: r.type || 'application/json', body: Buffer.from(r.data, 'base64') });
    misses.push(req.method() + ' ' + url.slice(0, 120));
    return route.abort();
  });
  await p.goto('https://www.youtube.com/robots.txt#ytlg');
  const t0 = Date.now();
  await p.addScriptTag({ path: 'dist/webOSUserScripts/userScript.js' });
  await p.waitForFunction(() => document.querySelectorAll('.card').length > 0, null, { timeout: 20000 }).catch(() => {});
  console.log('FIRST CARDS ms', Date.now() - t0);
  await p.waitForTimeout(3000);
  await p.screenshot({ path: S + '/replay_home.png' });
  const state = await p.evaluate(() => ({
    splash: document.querySelector('#splash .s-msg')?.textContent || null,
    cards: document.querySelectorAll('.card').length,
    empty: document.querySelector('.empty')?.textContent || null
  }));
  console.log('HOME', JSON.stringify(state));
  // search
  await p.evaluate(() => window.__ytlgApp.voiceSearch('خالد الجليل'));
  await p.waitForTimeout(2500);
  await p.screenshot({ path: S + '/replay_search.png' });
  console.log('SEARCH cards', await p.evaluate(() => document.querySelectorAll('.page .card').length), await p.evaluate(() => document.querySelector('.empty')?.textContent || ''));
  await p.evaluate(() => window.__ytlgApp.openChannel('UC-9-kyTW8ZkZNDHQJ6FgpwQ', 'Music'));
  await p.waitForTimeout(2500);
  console.log('CHANNEL cards', await p.evaluate(() => document.querySelectorAll('.page .card').length));
  await p.evaluate(() => window.__ytlgApp.go('news'));
  await p.waitForTimeout(2500);
  console.log('NEWS cards', await p.evaluate(() => document.querySelectorAll('.page .card').length), await p.evaluate(() => document.querySelector('.empty')?.textContent || ''));
  console.log('MISSES\n' + misses.slice(0, 20).join('\n'));
  console.log('LOGS\n' + logs.slice(0, 25).join('\n'));
  await b.close();
})();
