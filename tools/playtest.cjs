// CI playback probe: boots the built app on www.youtube.com/robots.txt (LG UA), plays real videos and records
// which qualities Shaka keeps, which it drops and why. Output: playtest.log (+ screenshots).
const { chromium } = require('playwright');
const fs = require('fs');

const VIDS = (process.env.VIDS || 'LXb3EKWsInQ,aqz-KE-bpKQ').split(',');
const UA = 'Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 WebAppManager';
const log = [];
const out = (s) => { log.push(s); console.log(s); };

async function probe(p) {
  return p.evaluate(async () => {
    const pl = window.__ytlgApp?.player;
    const sh = pl?.shaka;
    if (!sh) return { err: 'no shaka' };
    const m = sh.getManifest?.();
    const vars = (m?.variants || []).map((v) => ({
      h: v.video?.height, fps: Math.round(v.video?.frameRate || 0), vc: (v.video?.codecs || '').split('.')[0],
      ac: (v.audio?.codecs || '').split('.')[0], app: v.allowedByApplication, key: v.allowedByKeySystem
    }));
    const sum = {};
    for (const v of vars) {
      const k = `${v.h}p${v.fps} ${v.vc}`;
      sum[k] = sum[k] || { n: 0, allowed: 0, audio: new Set() };
      sum[k].n++; if (v.app && v.key) sum[k].allowed++; sum[k].audio.add(v.ac);
    }
    const table = Object.entries(sum).map(([k, s]) => `${k} variants=${s.n} allowed=${s.allowed} audio=${[...s.audio].join('/')}`);
    const fmts = (pl.info?.streaming_data?.adaptive_formats || []).filter((f) => f.has_video)
      .map((f) => `${f.height}p${f.fps} ${(f.mime_type.match(/codecs="([^".]+)/) || [])[1]}`);
    const cfg = sh.getConfiguration();
    const v = pl.video;
    // what the browser says about a few heights for the playing codec
    const act = sh.getVariantTracks().find((t) => t.active);
    const caps = [];
    for (const f of (pl.info?.streaming_data?.adaptive_formats || []).filter((x) => x.has_video).slice(0, 40)) {
      try {
        const r = await navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: f.mime_type, width: f.width, height: f.height, bitrate: f.bitrate, framerate: f.fps || 30 } });
        caps.push(`${f.height}p${f.fps} ${(f.mime_type.match(/codecs="([^"]+)/) || [])[1]} sup=${r.supported}`);
      } catch (e) { caps.push(`${f.height} err ${e.message}`); }
    }
    return {
      youtubeFormats: fmts.join(', '),
      manifestVariants: vars.length,
      table,
      restrictions: cfg.restrictions,
      abr: cfg.abr.enabled,
      active: act && `${act.height}p ${act.videoCodec} ${act.audioCodec}`,
      video: v && { t: Math.round(v.currentTime), rs: v.readyState, w: v.videoWidth, h: v.videoHeight, paused: v.paused },
      caps
    };
  });
}

(async () => {
  const b = await chromium.launch({ channel: process.env.CHANNEL || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ userAgent: UA, viewport: { width: 1920, height: 1080 }, locale: 'ar-SA' });
  const script = fs.readFileSync('app/dist/webOSUserScripts/userScript.js', 'utf8');
  await ctx.addInitScript({ content: `if (location.pathname === '/robots.txt' && window.top === window) { document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('script'); s.textContent = ${JSON.stringify(script)}; document.documentElement.appendChild(s); }); }` });
  const p = await ctx.newPage();
  p.on('console', (m) => { const t = m.text(); if (/\[(player|shaka|video|BotGuard|player-js|sabr)/i.test(t) || m.type() === 'error') out(`  [${m.type()}] ${t.slice(0, 300)}`); });
  p.on('pageerror', (e) => out('  [pageerror] ' + e.message));
  await p.goto('https://www.youtube.com/robots.txt', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__ytlgApp && !document.getElementById('splash'), null, { timeout: 60000 }).catch(() => out('app did not boot'));
  await p.waitForTimeout(4000);
  let i = 0;
  for (const id of VIDS) {
    i++;
    out(`\n######## VIDEO ${id}`);
    await p.evaluate((vid) => window.__ytlgApp.player.open({ id: vid, title: 'test' }), id);
    for (const sec of [10, 25]) {
      await p.waitForTimeout(sec === 10 ? 10000 : 15000);
      out(`--- after ${sec}s`);
      const r = await probe(p).catch((e) => ({ err: e.message }));
      out(JSON.stringify(r, null, 1));
    }
    await p.screenshot({ path: `shot${i}.png` });
    await p.evaluate(() => window.__ytlgApp.player.close()).catch(() => {});
    await p.waitForTimeout(1500);
  }
  fs.writeFileSync('playtest.log', log.join('\n'));
  await b.close();
})();
