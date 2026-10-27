const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const logs = []; p.on('pageerror', e => logs.push('PAGEERR ' + e.message)); p.on('console', m => logs.push(m.type() + ' ' + m.text().slice(0, 200)));
  await p.route('**/*', r => { const u = r.request().url(); if (u === 'https://www.youtube.com/robots.txt') return r.fulfill({ status: 200, contentType: 'text/plain', body: 'User-agent: *\nDisallow: /' }); logs.push('REQ ' + r.request().method() + ' ' + u.slice(0, 120)); return r.abort(); });
  await p.goto('https://www.youtube.com/robots.txt#ytlg');
  await p.addScriptTag({ path: 'dist/webOSUserScripts/userScript.js' });
  await p.waitForTimeout(2500);
  await p.screenshot({ path: '/tmp/claude-0/-home-claude/75c71062-6ad6-5134-bd7b-3ff6222bc137/scratchpad/smoke.png' });
  console.log(logs.join('\n'));
  console.log('SPLASH:', await p.evaluate(() => document.querySelector('#splash .s-msg')?.textContent));
  await b.close();
})();
