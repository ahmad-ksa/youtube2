const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/*', r => { const u = r.request().url(); if (/ytimg|yt3|ggpht/.test(u)) return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#345"/></svg>' }); return r.abort(); });
  await p.setContent('<html><body></body></html>');
  await p.addScriptTag({ path: 'fix.js' }); await p.addScriptTag({ path: 'harness.out.js' });
  await p.waitForTimeout(800);
  const S = '/tmp/claude-0/-home-claude/75c71062-6ad6-5134-bd7b-3ff6222bc137/scratchpad/';
  const st = () => p.evaluate(() => { const pl = app.player; const f = document.querySelector('.focused'); return `classes=[${pl.el.className}] focus=${f ? f.className.split(' ').slice(0,3).join('.') : 'none'} seekTarget=${pl.seekTarget} preview="${pl.el.querySelector('.preview span').textContent}"`; });
  await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  await p.evaluate(() => { const v = app.player.video; Object.defineProperty(v, 'duration', { value: 3600, configurable: true }); let ct = 0; Object.defineProperty(v, 'currentTime', { get: () => ct, set: (x) => { ct = x; }, configurable: true }); Object.defineProperty(v, 'paused', { get: () => true, configurable: true }); app.player.drawPlayState(); app.player.showMini(); });
  console.log('open/paused:', await st()); await p.screenshot({ path: S + 'p1_paused.png' });
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(300); console.log('down:', await st()); await p.screenshot({ path: S + 'p2_full.png' });
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(200); console.log('down2 (related):', await st());
  await p.keyboard.press('ArrowUp'); await p.waitForTimeout(200); console.log('up (buttons):', await st());
  await p.keyboard.press('ArrowUp'); await p.waitForTimeout(200); console.log('up (hide bar):', await st());
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(100); console.log('tap right:', await st());
  await p.waitForTimeout(1200); console.log('committed ct=', await p.evaluate(() => app.player.video.currentTime));
  for (let i = 0; i < 40; i++) { await p.keyboard.down('ArrowRight'); await p.waitForTimeout(150); }
  console.log('held 6s:', await st()); await p.screenshot({ path: S + 'p3_seek.png' });
  await p.keyboard.up('ArrowRight'); await p.waitForTimeout(200); console.log('released ct=', await p.evaluate(() => app.player.video.currentTime), await st());
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); console.log('back:', await st());
  console.log('ERRORS', errs);
  await b.close();
})();
