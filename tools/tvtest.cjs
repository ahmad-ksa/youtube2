// CI check: run our app on www.youtube.com/robots.txt with the LG TV user agent, open a video through
// YouTube's TV player and record what happens (logs + screenshots). No TV needed.
const { chromium } = require('playwright');
const fs = require('fs');
const VID = process.env.VID || 'XvRNIX30tO8';
const UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebAppManager';
(async () => {
  const b = await chromium.launch({ channel: process.env.CHANNEL || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ userAgent: UA, viewport: { width: 1920, height: 1080 }, locale: 'ar-SA' });
  const script = fs.readFileSync('app/dist/webOSUserScripts/userScript.js', 'utf8');
  await ctx.addInitScript({ content: `if (location.pathname === '/robots.txt' && window.top === window) { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('script'); s.textContent = ${JSON.stringify(script)}; document.documentElement.appendChild(s); }); }` });
  const p = await ctx.newPage();
  const log = [];
  p.on('console', (m) => { const t = `[${m.type()}] ${m.text()}`; if (!/WAM|YOUTUBEJS/.test(t)) log.push(t.slice(0, 400)); });
  p.on('pageerror', (e) => log.push('[pageerror] ' + e.message));
  await p.goto('https://www.youtube.com/robots.txt', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ytlgApp && !document.getElementById('splash'), null, { timeout: 60000 }).catch(() => log.push('app did not boot'));
  await p.waitForTimeout(6000);
  await p.screenshot({ path: 'shot0-home.png' });
  await p.evaluate((id) => window.__ytlgApp.player.open({ id, title: 'test' }), VID);
  for (let i = 1; i <= 8; i++) {
    await p.waitForTimeout(5000);
    const st = await p.evaluate(() => {
      const f = document.querySelector('.yt-frame'); let w; try { w = f.contentWindow; } catch { /* x */ }
      const out = { frameSrc: f && f.getAttribute('src') };
      try {
        out.hash = w.location.hash; const d = w.document; const v = d.querySelector('video'); const pl = d.querySelector('.html5-video-player');
        out.video = v ? { rs: v.readyState, t: Math.round(v.currentTime * 10) / 10, paused: v.paused, w: v.videoWidth, src: (v.currentSrc || '').slice(0, 30) } : null;
        out.api = !!pl; try { out.vd = pl && pl.getVideoData && pl.getVideoData(); } catch (e) { out.vdErr = e.message; }
        try { out.q = pl && pl.getPlaybackQualityLabel && pl.getPlaybackQualityLabel(); } catch { /* x */ }
        out.title = d.title; out.bodyText = (d.body && d.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300);
      } catch (e) { out.err = e.message; }
      return out;
    });
    log.push(`=== ${i * 5}s ` + JSON.stringify(st));
    if (i === 2 || i === 8) await p.screenshot({ path: `shot${i}.png` });
    // also the inner page with its UI visible (for diagnosis)
  }
  const inner = await p.evaluate(() => { try { const d = document.querySelector('.yt-frame').contentWindow.document; const s = d.getElementById('ytlg-hide'); if (s) s.remove(); return 'ok'; } catch (e) { return e.message; } });
  await p.waitForTimeout(500); await p.screenshot({ path: 'shot-inner-ui.png' }); log.push('inner ui ' + inner);
  fs.writeFileSync('tvtest.log', log.join('\n'));
  console.log(log.join('\n'));
  await b.close();
})();
