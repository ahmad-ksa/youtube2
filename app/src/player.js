// Video player: youtubei.js /player + SABR (googlevideo) + Shaka, with SmartTube-like quality control.
import shaka from 'shaka-player/dist/shaka-player.ui';
import { Constants, Utils, YT as YTP } from 'youtubei.js/web';
import { SabrStreamingAdapter } from 'googlevideo/sabr-streaming-adapter';
import { buildSabrFormat } from 'googlevideo/utils';
import { ShakaPlayerAdapter } from './ShakaPlayerAdapter.ts';
import { botguard } from './botguard.js';
import { yt } from './yt.js';
import { settings, history, favorites, resume, PRESETS, presetValue, presetLabel, setPreset } from './store.js';
import { sponsorblock } from './sponsorblock.js';
import { dearrow } from './dearrow.js';
import { chaptersFrom } from './extract.js';
import { KEY, dirOf, isBack, findNext, focus, current } from './nav.js';
import { h, toast, fmtTime, esc } from './dom.js';
import { ICON } from './icons.js';

const CLIENTS = ['VISIONOS', 'TV', 'WEB_EMBEDDED', 'IOS', 'MWEB'];
export const LANGS = [['ar', 'العربية'], ['en', 'English'], ['fr', 'Français'], ['tr', 'Türkçe'], ['ur', 'اردو'], ['id', 'Indonesia'], ['es', 'Español'], ['de', 'Deutsch']];
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

let shakaReady = false;

function codecOf(track) {
  const c = (track.videoCodec || '').toLowerCase();
  if (c.startsWith('av01')) return 'AV1';
  if (c.startsWith('vp9') || c.startsWith('vp09')) return 'VP9';
  if (c.startsWith('avc')) return 'H.264';
  return c.split('.')[0].toUpperCase();
}

function preferredCodecs() {
  const pref = settings.get('codec');
  if (pref === 'av01') return ['av01', 'vp09', 'vp9', 'avc1'];
  if (pref === 'vp9') return ['vp09', 'vp9', 'av01', 'avc1'];
  if (pref === 'avc1') return ['avc1'];
  // auto: best quality per bit the TV can decode in hardware
  return ['av01', 'vp09', 'vp9', 'avc1'];
}

const isHdrFormat = (f) => /SMPTEST2084|ARIB_STD_B67/.test(f.color_info?.transfer_characteristics || '') || /vp09\.02/.test(f.mime_type || '');
/** youtubei.js format_filter: true = drop. HDR streams are dropped unless HDR is enabled in settings. */
const formatFilter = (f) => f.has_video && !settings.get('hdrOn') && isHdrFormat(f);

/** The exact start streams (same rules as choosing 1080p in the quality menu): video + audio format. */
function startFormats(formats) {
  const codecOfF = (f) => ((f.mime_type || '').match(/codecs="([^"]+)"/) || [])[1] || '';
  let vids = formats.filter((f) => f.has_video && !f.has_audio && !formatFilter(f));
  // only streams this TV can decode (e.g. no AV1 on pre-2020 sets); otherwise the exact start can never match
  const decodable = vids.filter((f) => canDecode(f.mime_type));
  if (decodable.length) vids = decodable;
  // "H.264 (lighter)" is a hard choice: keep to H.264 even if that means a lower resolution
  if (settings.get('codec') === 'avc1') {
    const avc = vids.filter((f) => codecOfF(f).startsWith('avc1'));
    if (avc.length) vids = avc;
  }
  const q = settings.get('quality');
  const max = q === 'max' || q === 'auto' ? Infinity : Number(q) || 1080;
  let pool = vids.filter((f) => (f.height || 0) <= max);
  if (!pool.length) pool = vids.slice().sort((a, b) => a.height - b.height).slice(0, 1);
  if (!pool.length) return null;
  const topH = Math.max(...pool.map((f) => f.height || 0));
  pool = pool.filter((f) => f.height === topH);
  const fpsPref = settings.get('fps');
  if (fpsPref && fpsPref !== 'max' && pool.some((f) => f.fps === Number(fpsPref))) pool = pool.filter((f) => f.fps === Number(fpsPref));
  else { const topF = Math.max(...pool.map((f) => f.fps || 0)); pool = pool.filter((f) => (f.fps || 0) === topF); }
  const pref = preferredCodecs();
  const rank = (f) => { const i = pref.findIndex((p) => codecOfF(f).startsWith(p)); return i < 0 ? 99 : i; };
  // with HDR enabled, prefer the HDR stream of this resolution over SDR
  const hdrFirst = (f) => (settings.get('hdrOn') && isHdrFormat(f) ? 0 : 1);
  pool.sort((a, b) => (hdrFirst(a) - hdrFirst(b)) || (rank(a) - rank(b)) || ((a.bitrate || 0) - (b.bitrate || 0)));
  const v = pool[0];
  const auds = formats.filter((f) => f.has_audio && !f.has_video);
  const main = auds.filter((f) => !f.audio_track || f.audio_track.audio_is_default || f.is_original);
  const a = (main.length ? main : auds).slice().sort((x, y) => (y.bitrate || 0) - (x.bitrate || 0))[0];
  // start at 720p (same codec + fps, SDR) so the first piece arrives fast; switch up once it plays
  const fam = codecOfF(v).split('.')[0];
  const lows = vids.filter((f) => codecOfF(f).startsWith(fam) && !isHdrFormat(f) && (f.height || 0) <= 720 && (f.height || 0) < (v.height || 0));
  let low = null;
  if (lows.length) {
    const lh = Math.max(...lows.map((f) => f.height || 0));
    low = lows.filter((f) => f.height === lh).sort((x, y) => (Math.abs((x.fps || 0) - (v.fps || 0)) - Math.abs((y.fps || 0) - (v.fps || 0))) || ((x.bitrate || 0) - (y.bitrate || 0)))[0];
  }
  const first = low || v;
  return { v: first, target: v, upgrade: !!low, a, vCodec: codecOfF(first), aCodec: a ? codecOfF(a) : '' };
}

/** true when the TV reports it can decode this mime type (unknown = assume yes, so nothing is lost). */
function canDecode(mime) {
  try {
    if (!mime || typeof MediaSource === 'undefined' || !MediaSource.isTypeSupported) return true;
    return MediaSource.isTypeSupported(mime);
  } catch { return true; }
}

const maxHeight = (info) => Math.max(0, ...(info.streaming_data?.adaptive_formats || []).filter((f) => f.has_video).map((f) => f.height || 0));

/**
 * webOS' MediaCapabilities often answers "unsupported" for 4K VP9/AV1 even though the hardware decodes it
 * (the official YouTube app checks MediaSource.isTypeSupported with width/height). Fall back to that check.
 */
function patchMediaCapabilities() {
  const mc = navigator.mediaCapabilities;
  if (!mc || mc.__ytlg) return;
  const orig = mc.decodingInfo.bind(mc);
  const mseOk = (type, v) => {
    if (!type || typeof MediaSource === 'undefined') return false;
    if (!MediaSource.isTypeSupported(type)) return false;
    if (!v?.width) return true;
    // only trust formats the TV itself confirms for this exact size/fps (webOS extended query)
    return MediaSource.isTypeSupported(`${type}; width=${v.width}; height=${v.height}; framerate=${Math.round(v.framerate || 30)}`);
  };
  mc.decodingInfo = async (cfg) => {
    let r;
    try { r = await orig(cfg); } catch { r = { supported: false, smooth: false, powerEfficient: false }; }
    if (r.supported) return r;
    const vOk = !cfg.video || mseOk(cfg.video.contentType, cfg.video);
    const aOk = !cfg.audio || mseOk(cfg.audio.contentType);
    if (vOk && aOk && !cfg.keySystemConfiguration) {
      return { supported: true, smooth: true, powerEfficient: true, configuration: cfg };
    }
    return r;
  };
  mc.__ytlg = true;
}

export class Player {
  constructor(app) {
    this.app = app;
    this.el = h(`<div class="player layer">
      <div class="video-box"><video></video></div>
      <div class="spinner"><i></i></div>
      <div class="sb-toast"></div>
      <div class="center-icon"></div>
      <pre class="stats" dir="ltr"></pre>
      <div class="osd">
        <div class="osd-top"><div class="p-title"></div><div class="p-sub"></div></div>
        <div class="osd-bottom" dir="ltr">
          <div class="progress" dir="ltr"><div class="preview"><div class="pv-img"></div><span></span></div><div class="bar"><div class="buf"></div><div class="played"></div><div class="segs"></div><div class="chaps"></div><div class="knob"></div></div></div>
          <div class="times" dir="ltr"><span class="t-cur">0:00</span><span class="t-chap"></span><span class="t-info"></span><span class="t-dur">0:00</span></div>
          <div class="buttons">
            <button class="f" data-a="channel">القناة</button>
            <button class="f" data-a="quality">الجودة</button>
            <button class="f" data-a="speed">السرعة</button>
            <button class="f" data-a="captions">الترجمة</button>
            <button class="f" data-a="audio">الصوت</button>
            <button class="f" data-a="info">الوصف</button>
            <button class="f" data-a="comments">التعليقات</button>
            <i class="sep"></i>
            <button class="f b-sub" data-a="subscribe">اشتراك</button>
            <button class="f b-fav" data-a="fav">${ICON.heart} المفضلة</button>
            <button class="f" data-a="save">＋ حفظ</button>
            <button class="f b-like" data-a="like">👍 <span dir="rtl"></span></button>
            <button class="f b-dislike" data-a="dislike">👎</button>
            <i class="sep"></i>
            <button class="f" data-a="next">${ICON.next} التالي</button>
            <button class="f" data-a="prev">${ICON.prev} السابق</button>
          </div>
          <div class="related"><div class="row-title">مقترحات</div><div class="row-items"></div></div>
        </div>
      </div>
      <div class="menu"><div class="menu-title"></div><div class="menu-items scroll-y"></div></div>
    </div>`);
    this.video = this.el.querySelector('video');
    this.osd = this.el.querySelector('.osd');
    this.menu = this.el.querySelector('.menu');
    this.spinner = this.el.querySelector('.spinner');
    this.hideTimer = null;
    this.related = [];
    this.segments = [];
    this.loadToken = 0;

    this.el.querySelector('.related .row-items').addEventListener('click', (e) => {
      const c = e.target.closest('.card'); const it = c && this.app.cardData.get(c);
      if (it?.type === 'video') this.open(it);
    });
    this.el.querySelector('.buttons').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (b) this.action(b.dataset.a);
    });
    this.video.addEventListener('timeupdate', () => this.onTime());
    this.video.addEventListener('progress', () => this.drawProgress());
    this.video.addEventListener('waiting', () => this.spinner.classList.add('on'));
    this.video.addEventListener('playing', () => { this.spinner.classList.remove('on'); this.drawPlayState(); });
    this.video.addEventListener('pause', () => { this.drawPlayState(); if (!this.el.classList.contains('full')) this.showMini(); });
    this.video.addEventListener('ended', () => this.onEnded());
    this.video.addEventListener('ratechange', () => this.drawInfo());
    this.video.addEventListener('loadedmetadata', () => this.drawChapters());
    this.video.addEventListener('error', () => console.error('[video] MediaError', this.video.error?.code, this.video.error?.message));
    this.video.addEventListener('playing', () => console.info('[video] playing', this.video.videoWidth + 'x' + this.video.videoHeight));
    document.addEventListener('keyup', (e) => {
      if ((e.keyCode === KEY.LEFT || e.keyCode === KEY.RIGHT) && this.seekTarget != null) this.commitSeek();
    }, true);
  }

  async initShaka() {
    if (shakaReady) return;
    shaka.polyfill.installAll();
    patchMediaCapabilities();
    if (!shaka.Player.isBrowserSupported()) throw new Error('المتصفح لا يدعم المشغل');
    this.shaka = new shaka.Player();
    await this.shaka.attach(this.video);
    this.shaka.addEventListener('error', (e) => this.onShakaError(e.detail));
    this.shaka.addEventListener('variantchanged', () => this.drawInfo());
    this.shaka.addEventListener('adaptation', () => this.drawInfo());
    shakaReady = true;
  }

  configure() {
    const q = settings.get('quality');
    const hdrOk = !!settings.get('hdrOn');
    this.shaka.configure({
      abr: { enabled: false },
      ignoreHardwareResolution: true, // webOS reports the 1080p UI size, not the 4K panel
      preferredVideoCodecs: preferredCodecs(),
      preferredVideoHdrLevel: hdrOk ? 'PQ' : 'SDR',
      preferredTextLanguage: settings.get('captions') || '',
      streaming: {
        bufferingGoal: settings.get('buffer'),
        rebufferingGoal: 2,
        bufferBehind: 30,
        retryParameters: { maxAttempts: 6, baseDelay: 500, backoffFactor: 1.5, timeout: 30000 }
      },
      manifest: { retryParameters: { maxAttempts: 3 } }
    });
  }

  // ------------------------------------------------------------------ loading

  /** queue: optional list of items to play after this one (playlist mode). */
  async open(item, queue, isBack) {
    const token = ++this.loadToken;
    if (!isBack && this.item && this.app.isTop(this) && this.item.id !== item.id) (this.prevStack ||= []).push(this.item);
    if (!this.app.isTop(this)) this.prevStack = [];
    this.item = item;
    if (queue !== undefined) this.queue = queue || [];
    this.details = null;
    this.chapters = [];
    this.storyboard = null;
    this.drawChapters();
    this.drawActions();
    if (!this.app.isTop(this)) this.app.push(this);
    this.el.querySelector('.p-title').textContent = item.title || '';
    this.el.querySelector('.p-sub').textContent = item.sub || '';
    this.el.querySelector('.related .row-items').innerHTML = '';
    this.segments = [];
    this.spinner.classList.add('on');
    this.el.classList.remove('full');
    this.showMini();
    this.channelId = null;
    // side data in parallel with playback
    yt.related(item.id).then((r) => {
      if (token !== this.loadToken) return;
      this.related = r.items.slice(0, 20);
      this.details = r.details;
      if (r.details?.channelId) this.channelId ||= r.details.channelId;
      if (r.details?.subs || r.details?.views) {
        this.el.querySelector('.p-sub').textContent = [r.details.channel, r.details.subs, r.details.views, r.details.date].filter(Boolean).join(' • ');
      }
      if (!this.chapters.length && r.details?.description) { this.chapters = chaptersFrom(r.details.description); this.drawChapters(); }
      this.drawActions();
      const row = this.el.querySelector('.related .row-items');
      row.innerHTML = '';
      const list = this.queue?.length ? this.queue : this.related;
      this.el.querySelector('.related .row-title').textContent = this.queue?.length ? 'التالي في القائمة' : 'مقترحات';
      for (const it of list) row.appendChild(this.app.card(it));
    }).catch((e) => console.warn('[related]', e));
    dearrow.title(item.id).then((t) => { if (t && token === this.loadToken) this.el.querySelector('.p-title').textContent = t; });
    if (settings.get('sb')) {
      sponsorblock.get(item.id).then((segs) => {
        if (token !== this.loadToken) return;
        this.segments = segs; this.drawSegments();
      });
    }
    try {
      await this.initShaka();
      this.configure();
      await this.load(item.id, token);
    } catch (e) {
      if (token !== this.loadToken || this.reopening || e?.code === 7000) return; // 7000 = replaced by a reopen
      console.error('[player]', e);
      if (this.autoReselect()) { this.spinner.classList.remove('on'); return; }
      this.spinner.classList.remove('on');
      toast('تعذّر التشغيل: ' + (e?.message || e), 6000);
    }
  }

  async fetchPlayer(videoId, only, reloadCtx) {
    await yt.ensurePlayer();
    const tube = yt.tube;
    let lastReason = '';
    for (const client of only ? [only] : CLIENTS) {
      try {
        const resp = await tube.actions.execute('/player', {
          videoId,
          client,
          contentCheckOk: true,
          racyCheckOk: true,
          playbackContext: {
            contentPlaybackContext: { signatureTimestamp: tube.session.player?.signature_timestamp },
            ...(reloadCtx ? { reloadPlaybackContext: reloadCtx } : {})
          }
        });
        const cpn = Utils.generateRandomString(16);
        const info = new YTP.VideoInfo([resp], tube.actions, cpn);
        const st = info.playability_status?.status;
        if (st === 'OK' && info.streaming_data) {
          const best = maxHeight(info);
          console.info('[player] client', client, 'max', best + 'p', 'formats', info.streaming_data.adaptive_formats?.length);
          return { info, client, cpn };
        }
        lastReason = info.playability_status?.reason || st || 'unknown';
        console.warn('[player]', client, lastReason);
      } catch (e) {
        lastReason = e?.message || String(e);
        console.warn('[player]', client, 'failed', e);
      }
    }
    throw new Error(lastReason || 'لا يوجد بث');
  }

  async load(videoId, token, only, opts = {}) {
    await this.shaka.unload();
    this.sabr?.dispose();
    this.sabr = null;
    this.lastSaved = -1;
    if (opts.reloadCtx !== undefined || opts.at !== undefined) setTimeout(() => { this.reopening = false; }, 0); // old session is gone

    const { info, cpn, client } = await this.fetchPlayer(videoId, only || (opts.reloadCtx ? this.client : undefined), opts.reloadCtx);
    this.client = client;
    this.usedAlt = !only && client !== CLIENTS[0];
    if (token !== this.loadToken) return;
    this.info = info;
    const tube = yt.tube;
    const sd = info.streaming_data;
    const bi = info.basic_info;
    if (bi?.title) this.el.querySelector('.p-title').textContent = bi.title;
    const views = bi?.view_count ? Number(bi.view_count).toLocaleString('ar') + ' مشاهدة' : '';
    this.el.querySelector('.p-sub').textContent = [bi?.author, views].filter(Boolean).join(' • ');
    this.channelId = bi?.channel_id || null;
    this.drawActions();
    if (bi?.short_description) { this.chapters = chaptersFrom(bi.short_description); this.drawChapters(); this.description = bi.short_description; }
    this.storyboard = this.pickStoryboard(info.storyboards);
    history.add({ id: videoId, title: bi?.title || this.item.title, sub: bi?.author || this.item.sub, channelId: bi?.channel_id || '', duration: this.item.duration, thumb: this.item.thumb });
    const isLive = !!bi.is_live;
    const isPostLive = !!bi.is_post_live_dvr || (bi.is_live_content && !!(sd.dash_manifest_url || sd.hls_manifest_url));

    const plainFormats = (list) => {
      const seen = new Set();
      return (list || []).filter((f) => !f.is_vb && !f.is_drc).filter((f) => {
        const k = f.itag + '|' + (f.audio_track?.id || '');
        if (seen.has(k)) return false; seen.add(k); return true;
      });
    };
    if (sd?.adaptive_formats) sd.adaptive_formats = plainFormats(sd.adaptive_formats);
    this.autoFix = 0;
    let uri;
    if (isLive) uri = sd.dash_manifest_url ? `${sd.dash_manifest_url}/mpd_version/7` : sd.hls_manifest_url;
    else if (isPostLive) uri = sd.hls_manifest_url || (sd.dash_manifest_url ? `${sd.dash_manifest_url}/mpd_version/7` : undefined);

    if (!uri) {
      // SABR VOD
      const ctx = tube.session.context.client;
      this.sabr = new SabrStreamingAdapter({
        playerAdapter: new ShakaPlayerAdapter(),
        clientInfo: {
          osName: ctx.osName,
          osVersion: ctx.osVersion,
          clientName: parseInt(Constants.CLIENT_NAME_IDS[ctx.clientName]),
          clientVersion: ctx.clientVersion
        }
      });
      let poToken; let minting = false;
      const binding = videoId;
      const mint = async () => {
        if (minting) return; minting = true;
        try { poToken = await botguard.mint(binding); } finally { minting = false; }
      };
      mint(); // prepare the check token right away (YouTube asks for it after ~1 minute)
      this.sabr.onMintPoToken(async () => {
        if (!poToken) mint();
        return poToken || botguard.coldStart(binding) || '';
      });
      this.sabr.onReloadPlayerResponse(async (reloadContext) => {
        // like SmartTube: get a fresh player response for the new session and reopen the video at the same second
        this.reopen(videoId, token, reloadContext, 'reload');
      });
      this.sabr.attach(this.shaka);
      if (sd.server_abr_streaming_url) {
        this.sabr.setStreamingURL(await tube.session.player.decipher(sd.server_abr_streaming_url));
        this.sabr.setUstreamerConfig(info.player_config?.media_common_config.media_ustreamer_request_config?.video_playback_ustreamer_config);
        this.sabr.setServerAbrFormats(sd.adaptive_formats.filter((f) => !formatFilter(f)).map(buildSabrFormat));
        this.addTranslations(info);
        const mpd = await info.toDash({ format_filter: formatFilter, manifest_options: { is_sabr: true, captions_format: 'vtt', include_thumbnails: false } });
        uri = 'data:application/dash+xml;base64,' + btoa(unescape(encodeURIComponent(mpd)));
      } else {
        // non-SABR fallback: classic DASH with deciphered URLs
        this.addTranslations(info);
        const mpd = await info.toDash({ format_filter: formatFilter, manifest_options: { captions_format: 'vtt', include_thumbnails: false } });
        uri = 'data:application/dash+xml;base64,' + btoa(unescape(encodeURIComponent(mpd)));
      }
      if (botguard.ready === false) botguard.init();
    }

    if (token !== this.loadToken) return;
    const start = isLive ? undefined : (opts.at != null ? opts.at : resume.get(videoId) || undefined);
    // start directly on our exact 1080p stream: narrow the player's first choice down to it (no command, no search)
    this.shaka.configure({ streaming: { dontChooseCodecs: true } }); // keep every YouTube quality/codec in the menu
    const pick = !(uri && uri.startsWith('data:')) ? null : startFormats(sd.adaptive_formats || []);
    const q = settings.get('quality'), fps = settings.get('fps');
    const plainRestr = { maxHeight: q === 'max' || q === 'auto' ? Infinity : Number(q), maxFrameRate: fps === 'max' ? Infinity : Number(fps) };
    if (pick?.v) {
      const bw = (pick.v.bitrate || 0) + (pick.a?.bitrate || 0);
      console.info('[player] start', `${pick.v.height}p${pick.v.fps} ${pick.vCodec} | ${pick.aCodec}`);
      this.shaka.configure({
        abr: { enabled: false, defaultBandwidthEstimate: 1e9 },
        restrictions: {
          minHeight: pick.v.height, maxHeight: pick.v.height,
          minFrameRate: (pick.v.fps || 0) - 0.5, maxFrameRate: (pick.v.fps || 0) + 0.5,
          minBandwidth: bw ? Math.floor(bw * 0.97) : 0, maxBandwidth: bw ? Math.ceil(bw * 1.03) : Infinity
        }
      });
    } else {
      this.shaka.configure({ abr: { enabled: false, defaultBandwidthEstimate: 1e9 }, restrictions: plainRestr });
    }
    // like pressing 1080p by hand: once the player has its tracks but is not playing, re-select (repeat until it plays)
    // backup only when the video is really stuck: no new data for 2.5s (never while data is arriving)
    clearInterval(this.kickTimer);
    let lastEnd = -1; let since = Date.now();
    this.kickTimer = setInterval(() => {
      if (token !== this.loadToken || this.video.currentTime > 0.3 || this.video.readyState >= 3) { clearInterval(this.kickTimer); return; }
      const b = this.video.buffered; const end = b.length ? b.end(b.length - 1) : 0;
      if (end !== lastEnd) { lastEnd = end; since = Date.now(); return; }
      if (Date.now() - since < 2500 || !this.canReselect()) return;
      since = Date.now();
      if (!this.autoReselect()) {
        // every retry used up and still no picture: say so instead of spinning forever
        clearInterval(this.kickTimer);
        this.spinner.classList.remove('on');
        toast('تعذّر بدء الفيديو — جرّب جودة أقل أو ترميز H.264 من الإعدادات', 6000);
      }
    }, 300);
    try {
      await this.shaka.load(uri, start);
    } catch (e) {
      if (!pick?.v || token !== this.loadToken || this.reopening || e?.code === 7000) throw e;
      // the narrowed choice could not be met: start the normal way
      console.warn('[player] exact start failed', e?.code, '- normal start');
      this.shaka.configure({ restrictions: { minHeight: 0, minFrameRate: 0, minBandwidth: 0, maxBandwidth: Infinity, ...plainRestr } });
      await this.shaka.load(uri, start);
    }
    this.shaka.configure({
      restrictions: { minHeight: 0, maxHeight: Infinity, minFrameRate: 0, maxFrameRate: Infinity, minBandwidth: 0, maxBandwidth: Infinity }
    });
    if (token !== this.loadToken) return;
    const hs = [...new Set(this.shaka.getVariantTracks().map((t) => t.height))].sort((a, b) => b - a);
    console.info('[player] youtube max', maxHeight(info) + 'p', '| playable', hs.join(','), '| screen', screen.width + 'x' + screen.height);
    if (maxHeight(info) > (hs[0] || 0)) console.warn('[player] TV rejected higher formats', JSON.stringify(this.shaka.getVariantTracks().slice(0, 1).map((t) => t.videoCodec)));
    const act = this.shaka.getVariantTracks().find((t) => t.active);
    const onPick = pick?.v && act && act.height === pick.v.height && (act.videoCodec || '').startsWith(pick.vCodec.split('.')[0]);
    if (!onPick) this.applyQuality();
    else if (pick.upgrade) {
      console.info('[player] started on', `${act.height}p${Math.round(act.frameRate || 0)} ${act.videoCodec} ${act.audioCodec}`);
      // playing at 480p: go up to the chosen quality as soon as the picture moves
      const up = () => { if (token === this.loadToken) { console.info('[player] upgrade to', pick.target.height + 'p'); this.applyQuality(2); } };
      if (this.video.currentTime > 0.2 && !this.video.paused) up();
      else this.video.addEventListener('playing', up, { once: true });
    }
    else console.info('[player] started on', `${act.height}p${Math.round(act.frameRate || 0)} ${act.videoCodec} ${act.audioCodec}`);
    this.video.playbackRate = settings.get('speed');
    if (settings.get('captions')) this.setCaptions(settings.get('captions'));
    this.video.play().catch(() => { /* autoplay */ });
    this.isLive = isLive;
    if (yt.loggedIn) info.addToWatchHistory?.().catch?.(() => { /* best effort */ });
    this.drawInfo();
    this.hideOsdSoon();
  }

  // ---- formats (SmartTube style: every resolution / fps / codec / bitrate is selectable)

  /** one key per video stream (standard and high-bitrate "Premium" streams are separate choices) */
  static vKey(t) { return t.videoId != null ? 'v' + t.videoId : `${t.height}|${Math.round(t.frameRate || 0)}|${t.videoCodec}|${t.hdr || ''}|${t.videoBandwidth}`; }
  static fKey(t) { return `${t.height}|${Math.round(t.frameRate || 0)}|${(t.videoCodec || '').split('.')[0]}|${t.hdr || ''}`; }
  static aKey(t) { return `${(t.audioCodec || '').split('.')[0]}|${t.audioBandwidth || 0}|${t.channelsCount || 0}`; }

  videoFormats() {
    const map = new Map();
    for (const t of this.shaka.getVariantTracks()) {
      if (!t.videoCodec) continue;
      if (!map.has(Player.vKey(t))) map.set(Player.vKey(t), t);
    }
    // mark high-bitrate variants of the same resolution/fps/codec
    const groups = new Map();
    for (const t of map.values()) { const g = groups.get(Player.fKey(t)) || []; g.push(t); groups.set(Player.fKey(t), g); }
    for (const g of groups.values()) {
      const min = Math.min(...g.map((t) => t.videoBandwidth || 0));
      for (const t of g) t.__premium = g.length > 1 && (t.videoBandwidth || 0) > min * 1.4;
    }
    const pref = preferredCodecs();
    const rank = (t) => { const i = pref.findIndex((p) => (t.videoCodec || '').startsWith(p)); return i < 0 ? 99 : i; };
    return [...map.values()].sort((a, b) => (b.height - a.height) || ((b.frameRate || 0) - (a.frameRate || 0)) ||
      (rank(a) - rank(b)) || ((a.hdr && a.hdr !== 'SDR') - (b.hdr && b.hdr !== 'SDR')) || ((a.videoBandwidth || 0) - (b.videoBandwidth || 0)));
  }

  /** Selects the variant matching a video format (and keeps the current/preferred audio). */
  selectFormat(videoTrack, audioKey, margin = 8) {
    const all = this.shaka.getVariantTracks();
    const active = all.find((t) => t.active);
    const vk = Player.vKey(videoTrack);
    let cands = all.filter((t) => Player.vKey(t) === vk);
    if (active?.language) cands = cands.filter((t) => t.language === active.language).length ? cands.filter((t) => t.language === active.language) : cands;
    const wantA = audioKey || settings.get('audioFmt');
    const exact = wantA && wantA !== 'best' ? cands.find((t) => Player.aKey(t) === wantA) : null;
    const pick = exact || cands.sort((a, b) => (b.audioBandwidth || 0) - (a.audioBandwidth || 0))[0];
    if (!pick) return;
    this.shaka.configure({ abr: { enabled: false } });
    this.shaka.selectVariantTrack(pick, true, margin);
    console.info('[player] selected', `${pick.height}p${Math.round(pick.frameRate || 0)}`, pick.videoCodec, pick.hdr || '', pick.audioCodec);
    setTimeout(() => this.drawInfo(), 300);
  }

  applyQuality(margin) {
    let q = settings.get('quality');
    if (q === 'auto') { settings.set('quality', 'max'); q = 'max'; }
    let formats = this.videoFormats();
    if (!formats.length) return;
    // "H.264 (lighter)": stay on H.264 even at a lower resolution (same rule as the start stream)
    if (settings.get('codec') === 'avc1') {
      const avc = formats.filter((t) => (t.videoCodec || '').startsWith('avc1'));
      if (avc.length) formats = avc;
    }
    const max = q === 'max' ? Infinity : Number(q);
    const fit = formats.filter((t) => (t.height || 0) <= max);
    let pool = fit.length ? fit : formats.slice(-1);
    const topH = pool[0].height;
    pool = pool.filter((t) => t.height === topH);
    const fps = settings.get('fps');
    if (fps && fps !== 'max') {
      const same = pool.filter((t) => Math.round(t.frameRate || 0) === Number(fps));
      if (same.length) pool = same;
    }
    const codec = settings.get('codec');
    if (codec && codec !== 'auto') {
      const same = pool.filter((t) => (t.videoCodec || '').startsWith(codec === 'vp9' ? 'vp' : codec));
      if (same.length) pool = same;
    }
    const isHdr = (t) => t.hdr && t.hdr !== 'SDR';
    // HDR on: prefer HDR at this resolution; HDR off: SDR only
    const keep = pool.filter((t) => (settings.get('hdrOn') ? isHdr(t) : !isHdr(t)));
    if (keep.length) pool = keep;
    this.selectFormat(pool[0], undefined, margin ?? 8);
  }

  /** Same as opening the quality menu and choosing 1080p by hand (that recovers 3014/3015 on webOS). */
  canReselect() {
    try { return this.shaka.getVariantTracks().some((t) => t.active); } catch { return false; }
  }

  autoReselect() {
    if (!this.canReselect() || (this.autoFix || 0) >= 8) return false;
    this.autoFix = (this.autoFix || 0) + 1;
    console.warn('[player] auto reselect quality, try', this.autoFix);
    const t = this.video.currentTime;
    this.applyQuality();
    setTimeout(() => {
      if (t > 0 && Math.abs(this.video.currentTime - t) > 2) this.video.currentTime = t;
      this.video.play().catch(() => { /* ignore */ });
    }, 300);
    return true;
  }

  /** Reopen the current video from the same second with a fresh session (max 3 per video). */
  reopen(videoId, token, reloadCtx, why) {
    if (token !== this.loadToken || this.reopening) return false;
    // limit is 3 reopens close together: YouTube asks for routine reloads on long videos, so a quiet spell resets it
    const recent = Date.now() - (this.reopenAt || 0) < 120000;
    this.reopenCount = this.reopenVideo === videoId && recent ? (this.reopenCount || 0) : 0;
    this.reopenVideo = videoId;
    this.reopenAt = Date.now();
    if (this.reopenCount >= 3) { console.warn('[player] reopen limit reached'); return false; }
    this.reopenCount++;
    this.reopening = true;
    const at = this.video.currentTime > 1 ? this.video.currentTime : undefined;
    console.warn('[player] reopen', why, this.reopenCount, 'at', Math.round(at || 0) + 's');
    this.spinner.classList.add('on');
    setTimeout(() => {
      this.load(videoId, token, undefined, { reloadCtx, at })
        .catch((e) => { console.error('[player] reopen failed', e?.message); toast('تعذّر التشغيل: ' + (e?.message || e), 6000); })
        .finally(() => { this.reopening = false; });
    }, 0);
    return true;
  }

  onShakaError(err) {
    console.error('[shaka]', err);
    if (this.reopening) return;
    // server refused mid-video (1002 inside 1007/1002): reopen from the same second with a fresh session
    const inner = err?.code === 1007 ? err?.data?.[0] : err;
    if (err?.severity === 2 && (inner?.code === 1002 || err?.code === 1002) && this.item &&
        this.reopen(this.item.id, this.loadToken, null, 'server ' + (inner?.code || err.code))) return;
    if (err?.severity === 2 && this.autoReselect()) return;
    if (err?.severity === 2 && this.usedAlt && this.item) {
      // the sharper alternative client failed to stream: go back to the default one
      console.warn('[player] alt client failed, falling back to', CLIENTS[0]);
      this.usedAlt = false;
      const t = this.video.currentTime;
      this.load(this.item.id, this.loadToken, CLIENTS[0]).then(() => { if (t > 1) this.video.currentTime = t; }).catch((e) => toast('تعذّر التشغيل: ' + (e?.message || e), 6000));
      return;
    }
    if (err?.severity === 2) {
      this.spinner.classList.remove('on');
      toast(`خطأ في التشغيل (${err.code})`, 5000);
    }
  }

  // ------------------------------------------------------------------ UI

  drawPlayState() {
    const ci = this.el.querySelector('.center-icon');
    ci.innerHTML = this.video.paused ? ICON.play : ICON.pause;
    this.el.classList.toggle('paused', this.video.paused);
    if (!this.video.paused) { ci.classList.add('flash'); clearTimeout(this.ciTimer); this.ciTimer = setTimeout(() => ci.classList.remove('flash'), 600); }
  }

  drawInfo() {
    if (!this.shaka) return;
    const t = this.shaka.getVariantTracks().find((x) => x.active);
    const parts = [];
    if (t?.height) parts.push(`${t.height}p${t.frameRate > 30 ? Math.round(t.frameRate) : ''}`);
    if (t) parts.push(codecOf(t));
    if (t?.hdr && t.hdr !== 'SDR') parts.push('HDR');
    if (this.video.playbackRate !== 1) parts.push(this.video.playbackRate + 'x');
    if (this.isLive) parts.push('مباشر');
    this.el.querySelector('.t-info').textContent = parts.join(' • ');
  }

  drawProgress() {
    const d = this.video.duration || 0, c = this.seekTarget ?? (this.video.currentTime || 0);
    const pct = d && isFinite(d) ? (c / d) * 100 : 0;
    this.el.querySelector('.played').style.width = pct + '%';
    this.el.querySelector('.knob').style.left = pct + '%';
    const b = this.video.buffered;
    let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= c + 1) end = Math.max(end, b.end(i));
    this.el.querySelector('.buf').style.width = (d && isFinite(d) ? (end / d) * 100 : 0) + '%';
    this.el.querySelector('.t-cur').textContent = fmtTime(c);
    this.el.querySelector('.t-dur').textContent = isFinite(d) ? fmtTime(d) : '';
    const ch = this.chapterAt(c);
    this.el.querySelector('.t-chap').textContent = ch ? ch.title : '';
  }

  drawSegments() {
    const box = this.el.querySelector('.segs');
    box.innerHTML = '';
    const d = this.video.duration;
    if (!d || !isFinite(d)) { this.video.addEventListener('loadedmetadata', () => this.drawSegments(), { once: true }); return; }
    this.drawChapters();
    for (const s of this.segments) {
      const el = document.createElement('i');
      el.style.left = (s.start / d) * 100 + '%';
      el.style.width = Math.max(0.3, ((s.end - s.start) / d) * 100) + '%';
      box.appendChild(el);
    }
  }

  onTime() {
    this.drawProgress();
    const t = this.video.currentTime;
    const sec = Math.floor(t);
    // save every 5 s (once per mark, not on every timeupdate within that second)
    if (this.item && !this.isLive && sec % 5 === 0 && sec !== this.lastSaved) {
      this.lastSaved = sec;
      resume.set(this.item.id, t, this.video.duration);
    }
    for (const s of this.segments) {
      if (t >= s.start && t < s.end - 0.5 && !s.done) {
        s.done = true;
        this.video.currentTime = s.end;
        const box = this.el.querySelector('.sb-toast');
        box.textContent = 'تم التخطي: ' + sponsorblock.label(s.category);
        box.classList.add('on');
        setTimeout(() => box.classList.remove('on'), 2500);
      }
    }
  }

  nextItem() {
    if (this.queue?.length) return this.queue.shift();
    return this.related[0];
  }

  playNext() {
    const n = this.nextItem();
    if (!n) return false;
    toast('التالي: ' + n.title, 3000);
    this.open(n);
    return true;
  }

  onEnded() {
    if (this.item) resume.set(this.item.id, 0, 0);
    if (!(settings.get('autoplay') || this.queue?.length) || !this.playNext()) this.showOsd(true);
  }

  /** mini = title + progress (pause / seeking); full = + buttons + suggestions (opened with Down). */
  showMini() {
    this.el.classList.add('osd-on');
    this.el.classList.remove('full');
    if (this.el.contains(current())) { current().classList.remove('focused'); }
    this.hideOsdSoon(3000);
  }

  showOsd(keepFocus) { this.showFull(keepFocus); }

  showFull(keepFocus) {
    this.el.classList.add('osd-on', 'full');
    const cur = current();
    if (!keepFocus || !this.el.contains(cur) || !cur.classList.contains('focused')) focus(this.el.querySelector('.buttons .f'));
    this.hideOsdSoon(6000);
  }

  hideOsdSoon(ms = 5000) {
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!this.video.paused && !this.menu.classList.contains('on') && this.seekTarget == null) this.hideOsd();
    }, ms);
  }

  hideOsd() {
    this.el.classList.remove('osd-on', 'full');
    clearTimeout(this.hideTimer);
  }

  /** Hold-to-seek with acceleration: seconds first, then minutes, then 5 minutes. */
  seekHold(dir, repeat) {
    const now = Date.now();
    if (!repeat || !this.holdStart) { this.holdStart = now; this.lastStep = 0; }
    if (repeat && now - this.lastStep < 220) return;
    this.lastStep = now;
    const held = now - this.holdStart;
    const step = held < 1500 ? settings.get('seekStep') : held < 4500 ? 60 : 300;
    const d = this.video.duration;
    let t = (this.seekTarget ?? this.video.currentTime ?? 0) + dir * step;
    if (isFinite(d)) t = Math.min(Math.max(0, t), Math.max(0, d - 1));
    this.seekTarget = Math.max(0, t);
    this.seekLabel = (dir > 0 ? '»  +' : '«  -') + (step >= 60 ? step / 60 + ' min' : step + ' s');
    if (!this.el.classList.contains('full')) this.showMini();
    this.drawProgress();
    this.drawPreview();
    clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => this.commitSeek(), 900);
  }

  commitSeek() {
    clearTimeout(this.commitTimer);
    if (this.seekTarget == null) return;
    this.video.currentTime = this.seekTarget;
    this.seekTarget = null;
    this.holdStart = 0;
    this.drawProgress();
    this.hideOsdSoon(2500);
  }

  seek(delta) {
    const d = this.video.duration;
    let t = (this.video.currentTime || 0) + delta;
    if (isFinite(d)) t = Math.min(Math.max(0, t), d - 1);
    this.video.currentTime = Math.max(0, t);
    this.drawProgress();
  }

  togglePlay() { if (this.video.paused) this.video.play(); else this.video.pause(); }

  action(a) {
    switch (a) {
      case 'play': this.togglePlay(); break;
      case 'back': this.seek(-settings.get('seekStep')); break;
      case 'fwd': this.seek(settings.get('seekStep')); break;
      case 'like': this.rate('like'); break;
      case 'dislike': this.rate('dislike'); break;
      case 'subscribe': this.toggleSubscribe(); break;
      case 'fav': this.toggleFav(); break;
      case 'save': this.saveLater(); break;
      case 'audio': this.audioMenu(); break;
      case 'info': this.infoPanel(); break;
      case 'comments': this.commentsPanel(); break;
      case 'quality': this.qualityMenu(); break;
      case 'speed': this.speedMenu(); break;
      case 'captions': this.captionsMenu(); break;
      case 'channel': if (this.channelId) { this.close(); this.app.openChannel(this.channelId); } break;
      case 'next': this.playNext(); break;
      case 'prev': {
        const p = this.prevStack?.pop();
        if (p) { if (this.item) (this.queue ||= []).unshift(this.item); this.open(p, undefined, true); } else toast('لا يوجد فيديو سابق');
        break;
      }
    }
    this.hideOsdSoon();
  }

  // ------------------------------------------------------------------ menus

  openPanel(title, nodes, onFocusEnd) {
    this.menu.querySelector('.menu-title').textContent = title;
    const list = this.menu.querySelector('.menu-items');
    list.innerHTML = '';
    for (const n of nodes) list.appendChild(n);
    this.menu.classList.add('on', 'wide');
    this.menuReturn = current();
    this.panelMore = onFocusEnd || null;
    focus(list.querySelector('.f'));
  }

  openMenu(title, options, onPick) {
    this.menu.classList.remove('wide');
    this.panelMore = null;
    this.menu.querySelector('.menu-title').textContent = title;
    const list = this.menu.querySelector('.menu-items');
    list.innerHTML = '';
    let sel = null;
    for (const o of options) {
      const b = h(`<button class="f${o.on ? ' on' : ''}">${esc(o.label)}${o.hint ? `<small>${esc(o.hint)}</small>` : ''}</button>`);
      b.addEventListener('click', () => { onPick(o.value); this.closeMenu(); });
      list.appendChild(b);
      if (o.on) sel = b;
    }
    this.menu.classList.add('on');
    this.menuReturn = current();
    focus(sel || list.firstChild);
  }

  closeMenu() {
    this.menu.classList.remove('on', 'wide');
    focus(this.menuReturn || this.el.querySelector('.buttons .f'));
    this.hideOsdSoon();
  }

  /** Two levels like SmartTube: start quality for all videos (preset) + format for the current video only. */
  qualityMenu() {
    const formats = this.videoFormats();
    const active = this.shaka.getVariantTracks().find((t) => t.active);
    const abr = this.shaka.getConfiguration?.().abr?.enabled;
    const opts = [];
    if (!formats.length) opts.push({ label: 'الفيديو ما تحمّل — افتح سجل الأخطاء', value: 'logs' });
    // one entry per resolution/fps like the official app; the best codec for it is chosen automatically
    const gKey = (t) => `${t.height}|${Math.round(t.frameRate || 0)}|${t.hdr && t.hdr !== 'SDR' ? 'hdr' : ''}`;
    const groups = new Map();
    for (const t of formats) {
      if (!settings.get('hdrOn') && t.hdr && t.hdr !== 'SDR') continue;
      if (t.__premium) continue;
      if (!groups.has(gKey(t))) groups.set(gKey(t), t);
    }
    const activeG = active ? gKey(active) : '';
    for (const t of groups.values()) {
      const hdr = t.hdr && t.hdr !== 'SDR' ? ' HDR' : '';
      const fpsTxt = Math.round(t.frameRate || 0) > 30 ? String(Math.round(t.frameRate)) : '';
      opts.push({ label: `${t.height}p${fpsTxt}${hdr}`, hint: codecOf(active && gKey(active) === gKey(t) ? active : t), value: t, on: !abr && gKey(t) === activeG });
    }
    opts.push({ label: this.statsTimer ? 'إخفاء الإحصائيات' : 'عرض الإحصائيات', value: 'stats' });
    opts.push({ label: 'سجل الأخطاء', value: 'logs' });
    this.openMenu('الجودة', opts, (v) => {
      if (v === 'preset') { setTimeout(() => this.presetMenu(), 0); return; }
      if (v === 'stats') { this.toggleStats(); return; }
      if (v === 'logs') { window.__ytlgLogs?.(); return; }
      if (v === 'auto') { this.shaka.configure({ abr: { enabled: true } }); this.resumeAfterMenu(); return; }
      // this video only (the start preset stays as it is)
      this.selectFormat(v);
      this.resumeAfterMenu();
    });
  }

  presetMenu() {
    const cur = presetValue();
    this.openMenu('جودة البدء لكل الفيديوهات', PRESETS.map(([v, l]) => ({ label: l, value: v, on: v === cur })), (v) => {
      setPreset(v);
      this.applyQuality();
      toast('تُطبّق على كل الفيديوهات: ' + presetLabel(), 3000);
      this.resumeAfterMenu();
    });
  }

  /** After choosing an option: close everything and continue playing. */
  resumeAfterMenu() {
    setTimeout(() => {
      this.video.play().catch(() => { /* ignore */ });
      this.el.classList.remove('full');
      this.hideOsd();
    }, 0);
  }

  speedMenu() {
    const cur = this.video.playbackRate;
    this.openMenu('السرعة', SPEEDS.map((s) => ({ label: s + 'x', value: s, on: s === cur })), (v) => {
      this.video.playbackRate = v; settings.set('speed', v); this.resumeAfterMenu();
    });
  }

  /** Adds machine-translated caption tracks (YouTube auto-translate, like SmartTube). */
  addTranslations(info) {
    try {
      const tracks = info.captions?.caption_tracks;
      const lang = settings.get('translate');
      if (!tracks?.length || !lang) return;
      if (tracks.some((t) => t.language_code === lang || t.language_code.startsWith(lang + '-'))) return;
      const src = tracks.find((t) => t.kind !== 'asr' && t.is_translatable && t.language_code.startsWith('en')) ||
        tracks.find((t) => t.kind !== 'asr' && t.is_translatable) || tracks.find((t) => t.is_translatable);
      if (!src) return;
      const label = (LANGS.find((l) => l[0] === lang)?.[1] || lang) + ' (ترجمة آلية)';
      tracks.push({
        base_url: src.base_url + '&tlang=' + encodeURIComponent(lang),
        name: { toString: () => label },
        vss_id: 'tr.' + lang,
        language_code: lang,
        kind: 'translated',
        is_translatable: false
      });
    } catch (e) { console.warn('[captions] translate', e); }
  }

  captionsMenu() {
    const tracks = this.shaka.getTextTracks();
    const visible = this.shaka.isTextTrackVisible();
    const active = tracks.find((t) => t.active);
    const opts = [{ label: 'إيقاف', value: null, on: !visible }];
    for (const t of tracks) opts.push({ label: t.label || t.language, hint: t.language, value: t, on: visible && active === t });
    if (tracks.length) {
      const tl = settings.get('translate');
      opts.push({ label: 'لغة الترجمة الآلية: ' + (LANGS.find((l) => l[0] === tl)?.[1] || 'إيقاف'), value: 'tl' });
    }
    if (!tracks.length) { toast('لا توجد ترجمة لهذا الفيديو'); return; }
    this.openMenu('الترجمة', opts, (v) => {
      if (v === 'tl') { setTimeout(() => this.translateMenu(), 0); return; }
      if (!v) { settings.set('captions', ''); this.shaka.setTextTrackVisibility(false); this.resumeAfterMenu(); return; }
      settings.set('captions', v.language);
      this.shaka.selectTextTrack(v); this.shaka.setTextTrackVisibility(true); this.resumeAfterMenu();
    });
  }

  translateMenu() {
    const cur = settings.get('translate');
    this.openMenu('الترجمة الآلية إلى', [['', 'إيقاف'], ...LANGS].map(([v, l]) => ({ label: l, value: v, on: v === cur })), (v) => {
      settings.set('translate', v);
      toast('تُطبّق من الفيديو القادم، أو أعد فتح هذا الفيديو', 4000);
    });
  }

  setCaptions(lang) {
    if (!lang) { this.shaka.setTextTrackVisibility(false); return; }
    const t = this.shaka.getTextTracks().find((x) => x.language === lang) ||
      this.shaka.getTextTracks().find((x) => x.language.startsWith(lang.split('-')[0]));
    if (t) { this.shaka.selectTextTrack(t); this.shaka.setTextTrackVisibility(true); }
  }

  // ------------------------------------------------------------------ account actions

  drawActions() {
    const d = this.details;
    const like = this.el.querySelector('.b-like'), dis = this.el.querySelector('.b-dislike'), sub = this.el.querySelector('.b-sub');
    like.querySelector('span').textContent = d?.likes || '';
    like.classList.toggle('on', d?.likeStatus === 'LIKE');
    dis.classList.toggle('on', d?.likeStatus === 'DISLIKE');
    sub.textContent = d?.subscribed ? 'مشترك ✓' : 'اشتراك';
    sub.classList.toggle('on', !!d?.subscribed);
    const fav = this.el.querySelector('.b-fav');
    const on = favorites.has(this.channelId);
    fav.innerHTML = `${on ? ICON.heartOn : ICON.heart} المفضلة`;
    fav.classList.toggle('fav-on', on);
  }

  toggleFav() {
    if (!this.channelId) { toast('ما عرفت القناة'); return; }
    const name = this.info?.basic_info?.author || this.item?.sub || '';
    const on = favorites.toggle(this.channelId, name);
    toast(on ? `أُضيفت ${name} للمفضلة ❤` : `أُزيلت ${name} من المفضلة`);
    this.drawActions();
  }

  needLogin() {
    if (yt.loggedIn) return false;
    toast('سجّل الدخول من صفحة الحساب لاستخدام هذه الميزة', 4000);
    return true;
  }

  async rate(kind) {
    if (this.needLogin() || !this.item) return;
    const d = (this.details ||= {});
    const target = kind === 'like' ? 'LIKE' : 'DISLIKE';
    try {
      if (d.likeStatus === target) { await yt.unlike(this.item.id); d.likeStatus = 'INDIFFERENT'; }
      else { await (kind === 'like' ? yt.like(this.item.id) : yt.dislike(this.item.id)); d.likeStatus = target; }
      toast(d.likeStatus === 'LIKE' ? 'أعجبني ✓' : d.likeStatus === 'DISLIKE' ? 'لم يعجبني' : 'تم الإلغاء');
    } catch (e) { console.warn('[rate]', e); toast('تعذّر تنفيذ الطلب'); }
    this.drawActions();
  }

  async toggleSubscribe() {
    if (this.needLogin() || !this.channelId) return;
    const d = (this.details ||= {});
    try {
      if (d.subscribed) { await yt.unsubscribe(this.channelId); d.subscribed = false; toast('تم إلغاء الاشتراك'); }
      else { await yt.subscribe(this.channelId); d.subscribed = true; toast('تم الاشتراك ✓'); }
    } catch (e) { console.warn('[subscribe]', e); toast('تعذّر تنفيذ الطلب'); }
    this.drawActions();
  }

  async saveLater() {
    if (this.needLogin() || !this.item) return;
    try { await yt.watchLater(this.item.id); toast('أُضيف إلى "المشاهدة لاحقًا" ✓'); } catch (e) { console.warn('[save]', e); toast('تعذّر الحفظ'); }
  }

  // ------------------------------------------------------------------ panels

  infoPanel() {
    const nodes = [];
    const d = this.details || {};
    const title = this.el.querySelector('.p-title').textContent;
    nodes.push(h(`<div class="f para"><b>${esc(title)}</b><br><small>${esc([d.channel, d.subs, d.views, d.date].filter(Boolean).join(' • '))}</small></div>`));
    if (this.chapters.length) {
      nodes.push(h('<div class="sec">الفصول</div>'));
      for (const c of this.chapters) {
        const b = h(`<button class="f chap"><span dir="ltr">${fmtTime(c.start)}</span> ${esc(c.title)}</button>`);
        b.addEventListener('click', () => { this.video.currentTime = c.start; this.closeMenu(); });
        nodes.push(b);
      }
    }
    const desc = d.description || this.description || '';
    if (desc) {
      nodes.push(h('<div class="sec">الوصف</div>'));
      for (const para of desc.split(/\n{2,}/).filter((x) => x.trim())) nodes.push(h(`<div class="f para">${esc(para).replace(/\n/g, '<br>')}</div>`));
    }
    this.openPanel('الوصف', nodes);
  }

  async commentsPanel() {
    const token = this.details?.commentsToken;
    if (!token) { toast(this.details ? 'التعليقات غير متاحة' : 'جاري التحميل… حاول بعد لحظة'); return; }
    const list = [];
    let next = token, loading = false;
    const add = async () => {
      if (!next || loading) return;
      loading = true;
      try {
        const r = await yt.comments(next);
        next = r.continuation;
        const box = this.menu.querySelector('.menu-items');
        for (const c of r.items) {
          const n = h(`<div class="f comment"><div class="c-head"><b>${esc(c.author)}</b> <small>${esc(c.time)}</small>${c.likes ? ` <small>👍 ${esc(c.likes)}</small>` : ''}</div><div class="c-body">${esc(c.text).replace(/\n/g, '<br>')}</div></div>`);
          if (this.menu.classList.contains('on')) box.appendChild(n); else list.push(n);
        }
        if (!r.items.length) next = null;
      } catch (e) { console.warn('[comments]', e); next = null; toast('تعذّر تحميل التعليقات'); }
      loading = false;
    };
    await add();
    if (!list.length) { toast('لا توجد تعليقات'); return; }
    this.openPanel('التعليقات' + (this.details.commentsCount ? ` (${this.details.commentsCount})` : ''), list, add);
  }

  audioMenu() {
    const all = this.shaka.getVariantTracks();
    const active = all.find((t) => t.active);
    const names = typeof Intl !== 'undefined' && Intl.DisplayNames ? new Intl.DisplayNames(['ar'], { type: 'language' }) : null;
    const langName = (l) => { try { return names && l ? names.of(l) : l; } catch { return l; } };
    const opts = [];
    const langs = this.shaka.getAudioLanguagesAndRoles?.() || [];
    if (langs.length > 1) {
      for (const l of langs) opts.push({ label: '🌐 ' + langName(l.language) + (l.role ? ` (${l.role})` : ''), value: { lang: l }, on: l.language === active?.language });
    }
    const fm = new Map();
    for (const t of all) if (t.audioCodec && (!active?.language || t.language === active.language)) fm.set(Player.aKey(t), t);
    const fmts = [...fm.values()].sort((a, b) => (b.audioBandwidth || 0) - (a.audioBandwidth || 0));
    const cur = settings.get('audioFmt');
    opts.push({ label: 'أفضل صوت تلقائيًا', value: { fmt: 'best' }, on: !cur || cur === 'best' });
    for (const t of fmts) {
      const codec = (t.audioCodec || '').startsWith('opus') ? 'Opus' : (t.audioCodec || '').startsWith('mp4a') ? 'AAC' : (t.audioCodec || '').toUpperCase();
      opts.push({
        label: `${codec} • ${Math.round((t.audioBandwidth || 0) / 1000)} kbps${t.channelsCount ? ` • ${t.channelsCount === 6 ? '5.1' : t.channelsCount + 'ch'}` : ''}`,
        value: { fmt: Player.aKey(t) }, on: active && Player.aKey(active) === Player.aKey(t) && cur && cur !== 'best'
      });
    }
    this.openMenu('الصوت', opts, (v) => {
      if (v.lang) { this.shaka.selectAudioLanguage(v.lang.language, v.lang.role); setTimeout(() => this.applyQuality(), 300); this.resumeAfterMenu(); return; }
      settings.set('audioFmt', v.fmt);
      const vt = this.shaka.getVariantTracks().find((t) => t.active);
      if (vt) this.selectFormat(vt, v.fmt);
      this.resumeAfterMenu();
    });
  }

  // ------------------------------------------------------------------ chapters & storyboard

  drawChapters() {
    const box = this.el.querySelector('.chaps');
    box.innerHTML = '';
    const d = this.video.duration;
    if (!this.chapters?.length || !d || !isFinite(d)) return;
    for (const c of this.chapters.slice(1)) {
      const i = document.createElement('i');
      i.style.left = (c.start / d) * 100 + '%';
      box.appendChild(i);
    }
  }

  chapterAt(t) {
    let cur = null;
    for (const c of this.chapters || []) if (c.start <= t) cur = c;
    return cur;
  }

  pickStoryboard(sb) {
    try {
      const boards = sb?.boards || [];
      const b = boards.filter((x) => x.thumbnail_width >= 120).sort((a, b2) => a.thumbnail_width - b2.thumbnail_width)[0] || boards[boards.length - 1];
      if (!b?.template_url) return null;
      return b;
    } catch { return null; }
  }

  drawPreview() {
    const pv = this.el.querySelector('.preview');
    const t = this.seekTarget ?? (this.video.currentTime || 0), d = this.video.duration;
    if (!d || !isFinite(d)) return;
    pv.style.left = (t / d) * 100 + '%';
    pv.querySelector('span').innerHTML = (this.seekTarget != null && this.seekLabel ? `<em dir="ltr">${esc(this.seekLabel)}</em><br>` : '') + `<b dir="ltr">${fmtTime(t)}</b>` + (this.chapterAt(t) ? ' • ' + esc(this.chapterAt(t).title) : '');
    const b = this.storyboard;
    const img = pv.querySelector('.pv-img');
    if (b) {
      const per = b.columns * b.rows;
      const interval = b.interval > 0 ? b.interval / 1000 : d / Math.max(1, b.thumbnail_count);
      const idx = Math.min(b.thumbnail_count - 1, Math.floor(t / interval));
      const sheet = Math.floor(idx / per), pos = idx % per;
      const url = b.template_url.replace('$M', sheet);
      img.style.display = 'block';
      img.style.width = b.thumbnail_width + 'px';
      img.style.height = b.thumbnail_height + 'px';
      img.style.backgroundImage = `url("${url}")`;
      img.style.backgroundPosition = `-${(pos % b.columns) * b.thumbnail_width}px -${Math.floor(pos / b.columns) * b.thumbnail_height}px`;
      img.style.transform = `scale(${Math.min(2.4, 320 / b.thumbnail_width)})`;
    } else img.style.display = 'none';
    pv.classList.add('on');
    clearTimeout(this.pvTimer);
    this.pvTimer = setTimeout(() => pv.classList.remove('on'), 1500);
  }

  flashProgress() {
    this.el.classList.add('seek-on');
    this.drawPreview();
    clearTimeout(this.seekTimer);
    this.seekTimer = setTimeout(() => this.el.classList.remove('seek-on'), 1500);
  }

  toggleStats() {
    const el = this.el.querySelector('.stats');
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; el.classList.remove('on'); return; }
    let lastDropped = 0, lastDecoded = 0;
    const draw = () => {
      try {
        const st = this.shaka.getStats();
        const t = this.shaka.getVariantTracks().find((x) => x.active) || {};
        const q = this.video.getVideoPlaybackQuality?.() || {};
        const dropped = q.droppedVideoFrames || 0, decoded = q.totalVideoFrames || 0;
        const dRate = decoded - lastDecoded > 0 ? Math.round(((dropped - lastDropped) / (decoded - lastDecoded)) * 100) : 0;
        lastDropped = dropped; lastDecoded = decoded;
        const b = this.video.buffered, c = this.video.currentTime;
        let ahead = 0;
        for (let i = 0; i < b.length; i++) if (b.start(i) <= c + 0.5 && b.end(i) > c) ahead = b.end(i) - c;
        el.textContent = [
          `Video   ${t.width || '?'}x${t.height || '?'} @${Math.round(t.frameRate || 0)}fps  ${t.videoCodec || ''}  ${t.hdr || ''}`,
          `Audio   ${t.audioCodec || ''}  ${t.language || ''}`,
          `Bitrate ${((t.videoBandwidth || t.bandwidth || 0) / 1e6).toFixed(1)} Mbps   Net ${(st.estimatedBandwidth / 1e6).toFixed(1)} Mbps`,
          `Buffer  ${ahead.toFixed(1)} s   Stalls ${st.stallsDetected ?? 0}   Wait ${(st.bufferingTime || 0).toFixed(1)} s`,
          `Frames  dropped ${dropped}/${decoded}  (${dRate}% now)`,
          `Screen  ${screen.width}x${screen.height}  speed ${this.video.playbackRate}x`
        ].join('\n');
      } catch (e) { el.textContent = 'stats error ' + e.message; }
    };
    el.classList.add('on');
    draw();
    this.statsTimer = setInterval(draw, 1000);
  }

  // ------------------------------------------------------------------ keys

  onKey(e) {
    const k = e.keyCode;
    if (k === KEY.PLAY) { this.video.play(); return true; }
    if (k === KEY.PAUSE) { this.video.pause(); return true; }
    if (k === KEY.PLAYPAUSE) { this.togglePlay(); return true; }
    if (k === KEY.FF) { this.seekHold(1, e.repeat); return true; }
    if (k === KEY.RW) { this.seekHold(-1, e.repeat); return true; }
    if (k === KEY.STOP) { this.close(); return true; }
    if (k === KEY.YELLOW) { this.toggleStats(); return true; }

    if (this.menu.classList.contains('on')) {
      if (isBack(e)) { this.closeMenu(); return true; }
      const d = dirOf(k);
      if (d) {
        const n = findNext(this.menu, current(), d);
        if (n) focus(n);
        else if (d === 'down' && this.panelMore) this.panelMore();
        return true;
      }
      if (k === KEY.ENTER) { current()?.click(); return true; }
      return true;
    }

    const full = this.el.classList.contains('full');
    const d = dirOf(k);
    if (isBack(e)) {
      if (this.seekTarget != null) { this.seekTarget = null; this.drawProgress(); this.showMini(); return true; }
      if (full) { this.el.classList.remove('full'); if (this.video.paused) this.showMini(); else this.hideOsd(); return true; }
      this.close();
      return true;
    }
    if (!full) {
      // mini / hidden: arrows seek, OK plays/pauses, Down opens the bar
      if (k === KEY.LEFT || k === KEY.RIGHT) { this.seekHold(k === KEY.RIGHT ? 1 : -1, e.repeat); return true; }
      if (k === KEY.ENTER) { this.commitSeek(); this.togglePlay(); if (!this.video.paused) this.hideOsdSoon(1200); else this.showMini(); return true; }
      if (k === KEY.DOWN) { this.commitSeek(); this.showFull(); return true; }
      if (k === KEY.UP) { if (this.video.paused) this.showMini(); else this.hideOsd(); return true; }
      return false;
    }
    // full bar: normal navigation; Up from the buttons row hides the bar
    this.hideOsdSoon(6000);
    const cur = current();
    if (d === 'up' && cur && cur.closest('.buttons')) {
      this.el.classList.remove('full');
      cur.classList.remove('focused');
      if (this.video.paused) this.showMini(); else this.hideOsd();
      return true;
    }
    if (d) { const n = findNext(this.osd, cur, d); if (n) focus(n); return true; }
    if (k === KEY.ENTER) { cur?.click(); return true; }
    return false;
  }

  close() {
    this.loadToken++;
    // only save when the video really loaded; leaving early (duration unknown) must not erase the saved position
    if (this.item && !this.isLive && Number.isFinite(this.video.duration) && this.video.readyState >= 1) {
      resume.set(this.item.id, this.video.currentTime, this.video.duration);
    }
    try { this.video.pause(); } catch { /* ignore */ }
    this.shaka?.unload();
    this.sabr?.dispose(); this.sabr = null;
    this.closeMenuSilently();
    this.app.pop(this);
  }

  closeMenuSilently() { this.menu.classList.remove('on'); }
}
