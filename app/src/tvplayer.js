// Playback through YouTube's own TV player (https://www.youtube.com/tv), kept alive in a same-origin iframe.
// YouTube's player handles its streaming sessions / proof tokens itself (what webosbrew/youtube-webos relies on).
// Our UI stays for browsing; ads are removed like youtube-webos does (strip ad fields from parsed JSON).
import { h, toast } from './dom.js';
import { yt } from './yt.js';
import { history, resume } from './store.js';

const TV_URL = 'https://www.youtube.com/tv';
const BACK = [461, 27, 8];

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

export class TvPlayer {
  constructor(app) {
    this.app = app;
    this.el = h(`<div class="player tvp layer">
      <iframe class="tvp-frame" allow="autoplay; encrypted-media; fullscreen"></iframe>
      <div class="tvp-wait"><i></i><span>جاري تحميل مشغّل يوتيوب…</span></div>
    </div>`);
    this.frame = this.el.querySelector('iframe');
    this.wait = this.el.querySelector('.tvp-wait');
    this.item = null;
    this.queue = [];
    this.booted = false;
  }

  /** Start YouTube's TV app in the background right away, so the first video opens fast. */
  preload() {
    if (this.frame.getAttribute('src')) return;
    this.frame.setAttribute('src', TV_URL + '#/');
    this.watchFrame();
  }

  /** Hook every new document the iframe gets (as early as possible). */
  watchFrame() {
    clearInterval(this.hookTimer);
    const started = Date.now();
    this.hookTimer = setInterval(() => {
      try { this.hook(); } catch { /* not ready */ }
      if (Date.now() - started > 60000) clearInterval(this.hookTimer);
    }, 4);
    this.frame.addEventListener('load', () => { try { this.hook(); } catch { /* ignore */ } this.watchFrame(); }, { once: true });
  }

  hook() {
    const w = this.frame.contentWindow;
    if (!w || w.location.pathname !== '/tv' || w.__ytlgHooked) return;
    w.__ytlgHooked = true;
    this.hooked = true;
    // ad removal (same rule set as youtube-webos)
    const parse = w.JSON.parse;
    w.JSON.parse = function (...a) { return stripAds(parse.apply(this, a)); };
    const json = w.Response?.prototype?.json;
    if (json) w.Response.prototype.json = function () { return this.text().then((t) => w.JSON.parse(t)); };
    // back key inside YouTube's player = back to our app
    w.addEventListener('keydown', (e) => {
      if (BACK.includes(e.keyCode) && this.app.isTop(this)) { e.preventDefault(); e.stopImmediatePropagation(); this.close(); }
    }, true);
    w.document.addEventListener('DOMContentLoaded', () => { this.booted = true; }, { once: true });
    console.info('[tvplayer] YouTube TV player hooked');
    if (this.app.isTop(this)) setTimeout(() => this.focusFrame(), 0);
  }

  video() {
    try { return this.frame.contentWindow.document.querySelector('video'); } catch { return null; }
  }

  focusFrame() {
    // only hand the remote to YouTube's player once we can catch its back key (otherwise you could get stuck)
    try { if (!this.frame.contentWindow.__ytlgHooked) return; } catch { return; }
    try { this.frame.focus(); this.frame.contentWindow.focus(); } catch { /* ignore */ }
  }

  open(item, queue) {
    if (!item?.id) return;
    this.item = item;
    if (queue !== undefined) this.queue = queue || [];
    if (!this.app.isTop(this)) this.app.push(this);
    this.wait.classList.add('on');
    const at = resume.get(item.id);
    const hash = `#/watch?v=${encodeURIComponent(item.id)}${at ? `&t=${Math.floor(at)}s` : ''}`;
    if (!this.frame.getAttribute('src')) {
      this.frame.setAttribute('src', TV_URL + hash);
      this.watchFrame();
    } else {
      try { this.frame.contentWindow.location.hash = hash; } catch { this.frame.setAttribute('src', TV_URL + hash); this.watchFrame(); }
    }
    console.info('[tvplayer] open', item.id, at ? 'at ' + Math.floor(at) + 's' : '');
    // hide the waiting note once the picture moves
    clearInterval(this.waitTimer);
    const t0 = Date.now();
    this.waitTimer = setInterval(() => {
      const v = this.video();
      if ((v && v.currentTime > 0.1 && !v.paused) || Date.now() - t0 > 20000) { this.wait.classList.remove('on'); clearInterval(this.waitTimer); }
    }, 300);
    setTimeout(() => this.focusFrame(), 50);
    // keep our own history (with the channel, for "الجديد")
    history.add({ id: item.id, title: item.title || '', sub: item.sub || '', duration: item.duration, thumb: item.thumb });
    yt.related(item.id).then((r) => {
      const d = r.details || {};
      if (d.channelId || d.title) history.add({ id: item.id, title: d.title || item.title || '', sub: d.channel || item.sub || '', channelId: d.channelId || '', duration: item.duration, thumb: item.thumb });
    }).catch(() => { /* optional */ });
  }

  onKey(e) {
    // our page got the key (the iframe lost focus): back closes, anything else goes back to YouTube's player
    if (BACK.includes(e.keyCode)) { e.preventDefault(); this.close(); return; }
    this.focusFrame();
  }

  close() {
    clearInterval(this.waitTimer);
    const v = this.video();
    if (v && this.item) { try { resume.set(this.item.id, v.currentTime, v.duration); v.pause(); } catch { /* ignore */ } }
    try { this.frame.contentWindow.location.hash = '#/'; } catch { /* ignore */ }
    this.wait.classList.remove('on');
    this.app.pop(this);
  }

  // compatibility with code written for the old player
  voiceSearchClose() { this.close(); }
}

export function tvPlayerSupported() {
  return !!window.HTMLIFrameElement;
}

void toast;
