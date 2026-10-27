// User script: webOS injects this into the page the app navigates to (https://www.youtube.com/robots.txt),
// so every request runs same-origin with youtube.com. We then replace the page with our own TV UI.
import css from './styles.css';
import { tvMode } from './tvmode.js';
import { settings } from './store.js';
import { focus } from './nav.js';
import qrcode from 'qrcode-generator';

// webOS' browser throws "Illegal invocation" if fetch is called with a foreign `this`.
(() => {
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) { return nativeFetch.call(window, input, init); };
})();

const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
const HOME = 'https://www.youtube.com/robots.txt';

function videoIdFrom(s) {
  if (!s) return null;
  const m = String(s).match(/(?:[?&#]v=|v=|youtu\.be\/|\/watch\/|\/shorts\/)([\w-]{11})/);
  return m ? m[1] : (/^[\w-]{11}$/.test(s) ? s : null);
}

function parseParams(params) {
  try { if (typeof params === 'string') params = JSON.parse(params || '{}'); } catch { params = {}; }
  if (params && typeof params.target === 'string' && params.target.startsWith('{')) {
    try { params.target = JSON.parse(params.target); } catch { /* keep */ }
  }
  return params || {};
}

function launchVideo(params) {
  params = parseParams(params);
  return videoIdFrom(params.contentTarget) || (typeof params.target === 'string' ? videoIdFrom(params.target) : null) || null;
}

/** Voice / global search: {target:"q=..."} or {target:{intent, intentParam}} */
function launchQuery(params) {
  params = parseParams(params);
  const t = params.target;
  if (typeof t === 'string') {
    const m = t.match(/(?:^|[?&])q=([^&]+)/);
    if (m) return decodeURIComponent(m[1].replace(/\+/g, ' '));
  } else if (t && typeof t === 'object' && t.intentParam) {
    return String(t.intentParam);
  }
  if (params.query) return String(params.query);
  return null;
}

// ---- in-app log viewer (BLUE key) to help diagnose problems on the TV
const logs = [];
for (const lvl of ['log', 'info', 'warn', 'error']) {
  const orig = console[lvl].bind(console);
  console[lvl] = (...a) => {
    try {
      const first = String(a[0] ?? '');
      if (first.includes('[WAM]') || first.includes('[YOUTUBEJS]')) { orig(...a); return; }
      logs.push(`[${lvl[0].toUpperCase()}] ` + a.map((x) => x instanceof Error ? x.message : typeof x === 'object' ? JSON.stringify(x)?.slice(0, 300) : String(x)).join(' '));
      if (logs.length > 80) logs.shift();
    } catch { /* ignore */ }
    orig(...a);
  };
}
window.addEventListener('error', (e) => console.error('[uncaught]', e.message, e.filename + ':' + e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason?.message || e.reason));

async function checkUpdate() {
  try {
    const r = await fetch('https://raw.githubusercontent.com/ahmad-ksa/youtube2/repo/youtube.leanback.v4.manifest.json', { cache: 'no-store' });
    const m = await r.json();
    const n = (v) => String(v).split('.').map(Number);
    const [a, b] = [n(m.version), n(VERSION)];
    for (let i = 0; i < 3; i++) {
      if ((a[i] || 0) > (b[i] || 0)) {
        const { toast } = await import('./dom.js');
        toast(`يتوفر تحديث جديد v${m.version} — حدّثه من Homebrew Channel`, 8000);
        return;
      }
      if ((a[i] || 0) < (b[i] || 0)) return;
    }
  } catch { /* offline or blocked */ }
}

async function start() {
  document.documentElement.setAttribute('lang', 'ar');
  document.documentElement.innerHTML = `<head><meta charset="utf-8"><meta name="viewport" content="width=1920"><title>YouTube LG</title><style>${css}</style></head>
    <body dir="rtl"><div id="splash"><div class="logo">YouTube <b>LG</b></div><div class="s-msg">جاري التحميل…</div><div class="s-ver">v${VERSION}</div></div></body>`;

  const [{ App }, { yt }, { botguard }] = await Promise.all([import('./app.js'), import('./yt.js'), import('./botguard.js')]);
  const app = new App();
  window.__ytlgApp = app;
  app.mount();

  // log screen: OK shows the whole log as ONE QR code (scan with the phone camera)
  let qrPages = null; let qrIdx = 0;
  const drawQr = (el) => {
    const q = qrcode(0, 'L');
    q.addData(qrPages[qrIdx], 'Byte');
    q.make();
    const cell = Math.max(3, Math.floor(860 / (q.getModuleCount() + 8)));
    el.innerHTML = `<div class="qr-box">${q.createSvgTag({ cellSize: cell, margin: 4, scalable: true })}</div>
      <div class="qr-info">${qrPages.info} — صوّره بكاميرا الجوال • OK للنص • رجوع للإغلاق</div>`;
  };
  const showQr = async (el) => {
    const { compactLogs, logQrPayload } = await import('./logqr.js');
    const p = await logQrPayload(`YouTube LG v${VERSION}`, compactLogs(logs));
    qrPages = [p.data];
    qrPages.info = p.kind === 'text' ? 'السجل كاملًا كنص' : p.kind === 'link' ? 'رابط يعرض السجل كاملًا' : `آخر ${p.lines} سطر`;
    qrIdx = 0; drawQr(el);
  };
  const toggleLogs = () => {
    let el = document.getElementById('logs');
    if (el) { el.remove(); qrPages = null; return; }
    el = document.createElement('pre');
    el.id = 'logs';
    el.textContent = `YouTube LG v${VERSION}   (OK = رمز QR للجوال • رجوع للإغلاق)\n` + logs.slice(-45).join('\n');
    document.body.appendChild(el);
  };
  const logsKey = (e) => {
    const el = document.getElementById('logs');
    if (!el) return false;
    if (e.keyCode === 13) {
      if (qrPages) { qrPages = null; el.remove(); toggleLogs(); return true; }
      showQr(el).catch((err) => { el.textContent = 'تعذّر إنشاء رمز QR: ' + (err?.message || err); });
      return true;
    }
    return ['ArrowUp', 'ArrowDown'].includes(e.key) || [38, 40].includes(e.keyCode);
  };
  window.__ytlgLogs = toggleLogs;
  window.addEventListener('keydown', (e) => { // window capture runs before the app's own key handling
    const open = document.getElementById('logs');
    if (e.keyCode === 406 || (open && (e.keyCode === 461 || e.keyCode === 27 || e.keyCode === 8))) {
      toggleLogs(); e.preventDefault(); e.stopPropagation(); return;
    }
    if (open && logsKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  try {
    await yt.init();
  } catch (e) {
    console.error('[init]', e);
    document.querySelector('#splash .s-msg').textContent = 'تعذّر الاتصال بيوتيوب: ' + (e?.message || e) + ' — اضغط OK لإعادة المحاولة';
    document.addEventListener('keydown', (ev) => { if (ev.keyCode === 13) location.reload(); }, { once: true });
    return;
  }
  // our own player needs BotGuard; with YouTube's player (default) it is not used, so no extra requests
  if (settings.get('playerMode') === 'app') botguard.init();
  document.getElementById('splash')?.remove();

  // back from YouTube's TV player: reopen the page we left and put the focus on the video that was played
  const back = /[#&]back=1/.test(location.hash);
  let ret = null;
  if (back) {
    try { ret = JSON.parse(sessionStorage.getItem('ytlg.return') || 'null'); } catch { ret = null; }
    try { history.replaceState(null, '', HOME + '#ytlg'); } catch { /* ignore */ }
  } else checkUpdate();
  app.go(ret?.nav || 'home');
  if (ret?.id) {
    const t0 = Date.now();
    const find = setInterval(() => {
      const card = [...document.querySelectorAll('.page .card')].find((c) => app.cardData.get(c)?.id === ret.id);
      if (card) { focus(card); clearInterval(find); } else if (Date.now() - t0 > 8000) clearInterval(find);
    }, 200);
  }
  if (back) return; // launch parameters were already handled when the app started

  const lp = window.PalmSystem?.launchParams;
  const vid = launchVideo(lp) || videoIdFrom(location.hash);
  const q0 = launchQuery(lp) || (location.hash.match(/[#&]q=([^&]+)/) ? decodeURIComponent(location.hash.match(/[#&]q=([^&]+)/)[1]) : null);
  if (vid) app.player.open({ id: vid, title: '' });
  else if (q0) app.voiceSearch(q0);

  document.addEventListener('webOSRelaunch', (e) => {
    const v = launchVideo(e.detail);
    const q = launchQuery(e.detail);
    if (v) app.player.open({ id: v, title: '' });
    else if (q) { if (app.isTop(app.player)) app.player.close(); app.voiceSearch(q); }
  }, true);
}

(function boot() {
  if (window.top !== window) return; // YouTube TV player iframe: leave it alone
  if (window.__ytlgBooted) return;
  window.__ytlgBooted = true;
  if (location.hostname === 'www.youtube.com' && location.pathname === '/tv') {
    // official player mode: YouTube's own TV app plays the video; we only strip ads / return on exit
    tvMode(); // synchronously: the ad hook must be in place before YouTube's own scripts run
    return;
  }
  if (location.hostname !== 'www.youtube.com' || location.pathname !== '/robots.txt') {
    if (/youtube\.com$/.test(location.hostname)) location.replace(HOME + location.hash);
    return;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
