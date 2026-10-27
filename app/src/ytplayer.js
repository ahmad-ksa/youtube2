// Our player UI (same OSD/buttons/keys as before) driving YouTube's own TV player, which runs hidden in a
// same-origin iframe (https://www.youtube.com/tv). YouTube's player does the streaming (sessions, proof
// tokens) so videos are not cut; we only show its <video> and control it through its player API.
import { Player, LANGS } from './player.js';
import { yt } from './yt.js';
import { settings, history } from './store.js';
import { toast } from './dom.js';

const TV_URL = 'https://www.youtube.com/tv';
const FORWARD = ['timeupdate', 'progress', 'waiting', 'playing', 'pause', 'ended', 'ratechange', 'loadedmetadata', 'error'];
const QUALITY_KEY = { 4320: 'highres', 2160: 'hd2160', 1440: 'hd1440', 1080: 'hd1080', 720: 'hd720', 480: 'large', 360: 'medium', 240: 'small', 144: 'tiny' };

// ad removal: same rule set as webosbrew/youtube-webos
function stripAds(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.adPlacements) delete r.adPlacements;
  if (Array.isArray(r.adSlots)) delete r.adSlots;
  if (r.playerAds) delete r.playerAds;
  const strip = (sl) => {
    if (!sl?.contents) return;
    sl.contents = sl.contents.filter((e) => !e.adSlotRenderer && !e.tvMastheadRenderer);
    for (const c of sl.contents) {
      const hl = c.shelfRenderer?.content?.horizontalListRenderer;
      if (hl?.items) hl.items = hl.items.filter((e) => !e.adSlotRenderer);
    }
  };
  strip(r.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer);
  strip(r.contents?.sectionListRenderer);
  if (Array.isArray(r.entries)) r.entries = r.entries.filter((e) => !e?.command?.reelWatchEndpoint?.adClientParams?.isAd);
  return r;
}

// YouTube's TV UI is hidden; only its picture stays
const HIDE_CSS = `
html, body { background: #000 !important; }
body *:not(:has(video)):not(video) { opacity: 0 !important; }
video { object-fit: contain !important; }
`;

export class YtPlayer extends Player {
  constructor(app) {
    super(app);
    this.bus = this.video; // our own (hidden) <video>: the OSD listens to it, we forward YouTube's events to it
    this.bus.style.display = 'none';
    this.frame = document.createElement('iframe');
    this.frame.className = 'yt-frame';
    this.frame.setAttribute('allow', 'autoplay; encrypted-media');
    this.frame.setAttribute('tabindex', '-1');
    // the iframe lives outside the player layer at full size: YouTube's TV app lays itself out once at start,
    // so it must never be loaded inside a display:none element (it then never plays). Hidden = visibility only.
    document.body.appendChild(this.frame);
    this.el.classList.add('yt-mode');
    this.forwarded = new WeakSet();
    this.wantId = null;
    // while you browse our UI, YouTube's hidden page must stay silent (no home previews)
    setInterval(() => {
      if (this.app.isTop(this)) return;
      const v = this.ytVideo();
      try { if (v && !v.paused) v.pause(); if (v) v.muted = true; } catch { /* ignore */ }
    }, 1000);
    this.bus.addEventListener('playing', () => { try { if (this.video !== this.bus) this.video.muted = false; } catch { /* ignore */ } });
    // YouTube's page must never take the remote: keep focus in our app
    window.addEventListener('blur', () => {
      if (!this.app.isTop(this)) return;
      setTimeout(() => { try { if (document.activeElement === this.frame) this.frame.blur(); window.focus(); } catch { /* ignore */ } }, 0);
    });
  }

  // ------------------------------------------------------------------ YouTube TV page

  preload() {
    if (this.frame.getAttribute('src')) return;
    this.frame.setAttribute('src', TV_URL + '#/');
    this.watchFrame();
  }

  watchFrame() {
    clearInterval(this.hookTimer);
    const t0 = Date.now();
    this.hookTimer = setInterval(() => {
      try { this.hook(); } catch { /* not ready */ }
      if (Date.now() - t0 > 60000) clearInterval(this.hookTimer);
    }, 4);
    this.frame.addEventListener('load', () => { try { this.hook(); } catch { /* ignore */ } this.watchFrame(); }, { once: true });
  }

  win() { try { return this.frame.contentWindow; } catch { return null; } }

  hook() {
    const w = this.win();
    if (!w || w.location.pathname !== '/tv') return;
    if (!w.__ytlgHooked) {
      w.__ytlgHooked = true;
      const parse = w.JSON.parse;
      w.JSON.parse = function (...a) { return stripAds(parse.apply(this, a)); };
      if (w.Response?.prototype?.json) w.Response.prototype.json = function () { return this.text().then((t) => w.JSON.parse(t)); };
      console.info('[yt] TV player hooked');
    }
    const d = w.document;
    if (d.head && !d.getElementById('ytlg-hide')) {
      const st = d.createElement('style'); st.id = 'ytlg-hide'; st.textContent = HIDE_CSS; d.head.appendChild(st);
    }
    this.hookAccounts(w);
  }

  /** "Who's watching?" -> continue as guest automatically (youtube-webos auto-account-select). */
  hookAccounts(w) {
    if (w.__ytlgAccounts || typeof w._yttv !== 'object') return;
    for (const k in w._yttv) {
      const t = w._yttv[k];
      if (typeof t === 'function' && t.instance && typeof t.instance.resolveCommand === 'function') {
        const orig = t.instance.resolveCommand.bind(t.instance);
        t.instance.resolveCommand = (cmd, extra) => {
          if (cmd && cmd.startAccountSelectorCommand) {
            return orig({
              onIdentityChanged: {
                identityActionContext: { nextEndpoint: cmd.startAccountSelectorCommand.nextEndpoint, eventTrigger: 'ACCOUNT_EVENT_TRIGGER_WHOS_WATCHING', reloadRequired: undefined },
                isSameIdentity: true
              },
              commandMetadata: { webCommandMetadata: { clientAction: true } }
            }, extra);
          }
          return orig(cmd, extra);
        };
        w.__ytlgAccounts = true;
        console.info('[yt] account picker -> guest');
        return;
      }
    }
  }

  api() {
    try { return this.win()?.document.querySelector('.html5-video-player'); } catch { return null; }
  }

  ytVideo() {
    try { return this.win()?.document.querySelector('video'); } catch { return null; }
  }

  /** Use YouTube's <video> as ours and forward its events to our OSD. */
  adopt(v) {
    if (!v) return;
    this.video = v;
    if (this.forwarded.has(v)) return;
    this.forwarded.add(v);
    for (const type of FORWARD) v.addEventListener(type, () => { if (this.video === v) this.bus.dispatchEvent(new Event(type)); });
  }

  // ------------------------------------------------------------------ loading (replaces the Shaka path)

  async initShaka() { this.preload(); }
  configure() { /* YouTube's player */ }

  async load(videoId, token) {
    this.wantId = videoId;
    this.isLive = false;
    const at = this.startAt(videoId);
    const hash = `#/watch?v=${encodeURIComponent(videoId)}${at ? `&t=${Math.floor(at)}s` : ''}`;
    const w = this.win();
    let path = '';
    try { path = w?.location.pathname || ''; } catch { /* not ours yet */ }
    if (!this.frame.getAttribute('src') || path !== '/tv') {
      this.frame.setAttribute('src', TV_URL + hash);
      this.watchFrame();
    } else {
      w.location.hash = hash;
    }
    // wait for YouTube's video element to play this id (re-ask if YouTube went elsewhere, e.g. after the account screen)
    const t0 = Date.now();
    let lastNudge = Date.now(), lastLog = 0, tries = 0;
    while (token === this.loadToken) {
      const p = this.api();
      const v = this.ytVideo();
      let cur = null;
      try { cur = p?.getVideoData?.()?.video_id; } catch { /* ignore */ }
      if (v && cur === videoId) { this.adopt(v); break; }
      const now = Date.now();
      if (now - lastLog > 3000) {
        lastLog = now;
        let hashNow = '';
        try { hashNow = this.win().location.hash; } catch { /* ignore */ }
        console.info('[yt] waiting', Math.round((now - t0) / 1000) + 's', '| hash', hashNow.slice(0, 40), '| api', !!p, typeof p?.getVideoData, '| id', cur, '| video', !!v, v ? v.readyState + ' ' + Math.round(v.currentTime) : '');
      }
      if (now - lastNudge > 4000) {
        // only re-ask when YouTube lost the address (e.g. after the account screen); never interrupt a loading video
        lastNudge = now; tries++;
        try {
          const ww = this.win();
          if (ww && !ww.location.hash.includes(videoId)) { ww.location.hash = hash; console.info('[yt] hash again'); }
          else if (tries >= 3 && p?.loadVideoById && !(v && v.readyState > 0)) { p.loadVideoById(videoId, at || 0); console.info('[yt] loadVideoById'); }
        } catch (e) { console.warn('[yt] nudge', e?.message); }
      }
      if (now - t0 > 30000) throw new Error('مشغّل يوتيوب ما استجاب');
      await new Promise((r) => setTimeout(r, 150));
    }
    if (token !== this.loadToken) return;
    // YouTube's own autoplay must not switch videos behind our back (our bar decides what plays next)
    clearInterval(this.guardTimer);
    this.guardTimer = setInterval(() => {
      if (token !== this.loadToken) { clearInterval(this.guardTimer); return; }
      try {
        const id = this.api()?.getVideoData?.()?.video_id;
        if (id && this.wantId && id !== this.wantId) { this.api().pauseVideo?.(); this.ytVideo()?.pause(); }
      } catch { /* ignore */ }
    }, 1000);
    this.video.playbackRate = settings.get('speed');
    try { this.video.play(); } catch { /* autoplay */ }
    // start quality like before: 1080p (or the start-quality setting)
    this.afterStart(token);
    // details for our bar / history
    const p = this.api();
    let vd = {};
    try { vd = p.getVideoData() || {}; } catch { /* ignore */ }
    if (vd.title) this.el.querySelector('.p-title').textContent = vd.title;
    if (vd.author && !this.el.querySelector('.p-sub').textContent) this.el.querySelector('.p-sub').textContent = vd.author;
    try { this.isLive = !!p.getVideoData?.().isLive; } catch { /* ignore */ }
    history.add({ id: videoId, title: vd.title || this.item.title, sub: vd.author || this.item.sub, channelId: this.details?.channelId || '', duration: this.item.duration, thumb: this.item.thumb });
    if (!this.details?.channelId) {
      yt.related(videoId).then((r) => {
        if (r.details?.channelId) history.add({ id: videoId, title: vd.title || this.item.title, sub: vd.author || this.item.sub, channelId: r.details.channelId, duration: this.item.duration, thumb: this.item.thumb });
      }).catch(() => { /* optional */ });
    }
    this.drawInfo();
    this.drawSegments();
    this.hideOsdSoon();
    if (settings.get('captions')) this.setCaptions(settings.get('captions'));
  }

  startAt(id) {
    try { return Number(JSON.parse(localStorage.getItem('ytlg.pos') || '{}')[id]) || 0; } catch { return 0; }
  }

  afterStart(token) {
    const want = Number(settings.get('quality')) || 1080;
    const apply = () => {
      if (token !== this.loadToken) return;
      const p = this.api();
      try {
        const levels = (p.getAvailableQualityData?.() || []).filter((q) => q.isPlayable !== false);
        const fit = levels.find((q) => parseInt(q.qualityLabel, 10) <= want) || levels[levels.length - 1];
        if (fit) { p.setPlaybackQualityRange(fit.quality, fit.quality, fit.formatId); console.info('[yt] quality', fit.qualityLabel); }
        else if (QUALITY_KEY[want]) p.setPlaybackQualityRange(QUALITY_KEY[want], QUALITY_KEY[want]);
      } catch (e) { console.warn('[yt] quality', e?.message); }
      setTimeout(() => this.drawInfo(), 800);
    };
    if (!this.video.paused && this.video.currentTime > 0) apply();
    else this.video.addEventListener('playing', apply, { once: true });
  }

  // ------------------------------------------------------------------ menus through YouTube's player API

  drawInfo() {
    const parts = [];
    try { const q = this.api()?.getPlaybackQualityLabel?.(); if (q) parts.push(q); } catch { /* ignore */ }
    if (this.video.playbackRate !== 1) parts.push(this.video.playbackRate + 'x');
    if (this.isLive) parts.push('مباشر');
    this.el.querySelector('.t-info').textContent = parts.join(' • ');
  }

  qualityMenu() {
    const p = this.api();
    let levels = [];
    try { levels = (p?.getAvailableQualityData?.() || []).filter((q) => q.isPlayable !== false); } catch { /* ignore */ }
    let cur = '';
    try { cur = p.getPlaybackQualityLabel(); } catch { /* ignore */ }
    const seen = new Set();
    const opts = [];
    for (const q of levels) {
      if (seen.has(q.qualityLabel)) continue; seen.add(q.qualityLabel);
      opts.push({ label: q.qualityLabel.replace(/ ?Premium/i, ' • Premium'), value: q, on: q.qualityLabel === cur });
    }
    if (!opts.length) opts.push({ label: 'الجودات تظهر بعد ما يبدأ الفيديو', value: 'none' });
    opts.push({ label: this.statsTimer ? 'إخفاء الإحصائيات' : 'عرض الإحصائيات', value: 'stats' });
    opts.push({ label: 'سجل الأخطاء', value: 'logs' });
    this.openMenu('الجودة', opts, (v) => {
      if (v === 'none') return;
      if (v === 'stats') { this.toggleStats(); return; }
      if (v === 'logs') { window.__ytlgLogs?.(); return; }
      try { p.setPlaybackQualityRange(v.quality, v.quality, v.formatId); } catch (e) { toast('تعذّر تغيير الجودة'); console.warn(e); }
      setTimeout(() => this.drawInfo(), 1000);
      this.resumeAfterMenu();
    });
  }

  speedMenu() {
    const SP = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    const cur = this.video.playbackRate;
    this.openMenu('السرعة', SP.map((s) => ({ label: s + 'x', value: s, on: s === cur })), (v) => {
      try { this.api()?.setPlaybackRate?.(v); } catch { /* ignore */ }
      this.video.playbackRate = v; settings.set('speed', v); this.resumeAfterMenu();
    });
  }

  captionTracks() {
    try { return this.api()?.getOption?.('captions', 'tracklist') || []; } catch { return []; }
  }

  captionsMenu() {
    const p = this.api();
    const tracks = this.captionTracks();
    let cur = null;
    try { cur = p.getOption('captions', 'track'); } catch { /* ignore */ }
    const on = !!cur?.languageCode;
    const opts = [{ label: 'إيقاف', value: null, on: !on }];
    for (const t of tracks) opts.push({ label: t.displayName || t.languageName || t.languageCode, hint: t.languageCode, value: t, on: on && cur.languageCode === t.languageCode && (cur.kind || '') === (t.kind || '') });
    const tl = settings.get('translate');
    if (tracks.length && tl) opts.push({ label: 'ترجمة آلية إلى ' + (LANGS.find((l) => l[0] === tl)?.[1] || tl), value: 'auto' });
    if (!tracks.length) { toast('لا توجد ترجمة لهذا الفيديو'); return; }
    this.openMenu('الترجمة', opts, (v) => {
      try {
        if (!v) { settings.set('captions', ''); p.setOption('captions', 'track', {}); p.unloadModule?.('captions'); }
        else if (v === 'auto') { p.loadModule?.('captions'); p.setOption('captions', 'track', { ...tracks[0], translationLanguage: { languageCode: tl } }); settings.set('captions', tl); }
        else { p.loadModule?.('captions'); p.setOption('captions', 'track', v); settings.set('captions', v.languageCode); }
      } catch (e) { toast('تعذّر تغيير الترجمة'); console.warn(e); }
      this.resumeAfterMenu();
    });
  }

  setCaptions(lang) {
    const p = this.api();
    if (!p || !lang) return;
    setTimeout(() => {
      const t = this.captionTracks().find((x) => x.languageCode === lang) || this.captionTracks().find((x) => (x.languageCode || '').startsWith(lang.split('-')[0]));
      try { if (t) { p.loadModule?.('captions'); p.setOption('captions', 'track', t); } } catch { /* ignore */ }
    }, 1500);
  }

  audioMenu() {
    const p = this.api();
    let tracks = [];
    try { tracks = p?.getAvailableAudioTracks?.() || []; } catch { /* ignore */ }
    if (tracks.length < 2) { toast('هذا الفيديو فيه صوت واحد'); return; }
    let cur = null;
    try { cur = p.getAudioTrack?.(); } catch { /* ignore */ }
    const name = (t) => { try { return t.getLanguageInfo?.().getName?.() || t.name || t.id; } catch { return t.id || '?'; } };
    const opts = tracks.map((t) => ({ label: '🌐 ' + name(t), value: t, on: cur && (cur.id || name(cur)) === (t.id || name(t)) }));
    this.openMenu('الصوت', opts, (v) => {
      try { p.setAudioTrack(v); } catch (e) { toast('تعذّر تغيير الصوت'); console.warn(e); }
      this.resumeAfterMenu();
    });
  }

  toggleStats() {
    const el = this.el.querySelector('.stats');
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; el.classList.remove('on'); return; }
    const draw = () => {
      try {
        const p = this.api();
        const v = this.video;
        const q = v.getVideoPlaybackQuality?.() || {};
        const b = v.buffered, c = v.currentTime;
        let ahead = 0;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= c + 0.5 && b.end(i) > c) ahead = b.end(i) - c;
        el.textContent = [
          `Video   ${v.videoWidth}x${v.videoHeight}  ${p?.getPlaybackQualityLabel?.() || ''}`,
          `Buffer  ${ahead.toFixed(1)} s`,
          `Frames  dropped ${q.droppedVideoFrames || 0}/${q.totalVideoFrames || 0}`,
          `Player  YouTube TV  speed ${v.playbackRate}x`
        ].join('\n');
      } catch (e) { el.textContent = 'stats error ' + e.message; }
    };
    el.classList.add('on');
    draw();
    this.statsTimer = setInterval(draw, 1000);
  }

  addTranslations() { /* YouTube handles its own caption tracks */ }
  onShakaError() { /* not used */ }

  close() {
    this.loadToken++;
    const v = this.video;
    if (this.item && !this.isLive && v !== this.bus) {
      try {
        const all = JSON.parse(localStorage.getItem('ytlg.pos') || '{}');
        if (v.duration && v.currentTime > 15 && v.currentTime < v.duration - 20) all[this.item.id] = Math.floor(v.currentTime); else delete all[this.item.id];
        localStorage.setItem('ytlg.pos', JSON.stringify(all));
      } catch { /* ignore */ }
    }
    try { this.api()?.pauseVideo?.(); } catch { /* ignore */ }
    try { if (v !== this.bus) v.pause(); } catch { /* ignore */ }
    try { const w = this.win(); if (w) w.location.hash = '#/'; } catch { /* ignore */ }
    this.video = this.bus;
    this.wantId = null;
    this.closeMenuSilently();
    this.app.pop(this);
  }
}
