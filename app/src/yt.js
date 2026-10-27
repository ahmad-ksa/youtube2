// InnerTube access through youtubei.js (runs inside the youtube.com origin, so no CORS issues).
import { Innertube, Platform, UniversalCache, Player as YTPlayer } from 'youtubei.js/web';
import { extract, videoDetails, comments } from './extract.js';
import { settings, history, favorites } from './store.js';

Platform.shim.eval = async (data) => new Function(data.output)();
// webOS' browser throws "Illegal invocation" when fetch is called with another `this`.
export const boundFetch = (input, init) => window.fetch(input, init);
Platform.shim.fetch = boundFetch;

export const TOPICS = {
  music: { id: 'UC-9-kyTW8ZkZNDHQJ6FgpwQ', title: 'موسيقى' },
  gaming: { id: 'UCOpNcN46UbXVtpKMrmU4Abg', title: 'ألعاب' },
  news: { id: 'UCYfdidRxbB8Qhf0Nx7ioOYw', title: 'أخبار' },
  sports: { id: 'UCEgdi0XIXXZ-qJOFPf4JSKw', title: 'رياضة' },
  live: { id: 'UC4R8DWoMoI7CAwX8_LjQHig', title: 'مباشر' }
};

/** Age in seconds from a relative date text ("منذ 3 ساعات", "قبل يومين", "2 days ago"). Unknown -> very old. */
export function ageOf(meta) {
  const t = String(meta || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const units = [
    [/ثاني|second/, 1], [/دقيق|دقائق|minute/, 60], [/ساع|hour/, 3600], [/يوم|أيام|ايام|day/, 86400],
    [/أسبوع|اسبوع|أسابيع|اسابيع|week/, 604800], [/شهر|أشهر|اشهر|month/, 2592000], [/سن|عام|أعوام|year/, 31536000]
  ];
  for (const [re, sec] of units) {
    const m = t.match(new RegExp('(?:(\\d+)\\s*)?(' + re.source + ')[^\\s•]*'));
    if (!m) continue;
    let n = m[1] ? Number(m[1]) : 1;
    if (!m[1] && /(ين|ان)$/.test(m[0]) && !/ثواني|دقائق|أيام|ايام|ساعات/.test(m[0])) n = 2; // dual: يومين، ساعتين، شهرين
    return n * sec;
  }
  return 1e12;
}

/** Age of an item in seconds: exact publish time when known (RSS), else parsed from its date text. */
export function itemAge(it) {
  if (it.publishedAt) return Math.max(0, (Date.now() - it.publishedAt) / 1000);
  const m = ageOf(it.meta);
  return m < 1e12 ? m : ageOf(it.sub); // some layouts put "views • date" in the first line
}

/** "منذ 3 ساعات"-style text from seconds. */
export function relTime(sec) {
  const u = [[31536000, 'سنة', 'سنوات'], [2592000, 'شهر', 'أشهر'], [604800, 'أسبوع', 'أسابيع'], [86400, 'يوم', 'أيام'], [3600, 'ساعة', 'ساعات'], [60, 'دقيقة', 'دقائق']];
  for (const [n, one, many] of u) {
    const k = Math.floor(sec / n);
    if (k >= 1) return 'منذ ' + (k === 1 ? one : k === 2 ? (one === 'سنة' ? 'سنتين' : one === 'ساعة' ? 'ساعتين' : one === 'دقيقة' ? 'دقيقتين' : one + 'ين') : k + ' ' + (k <= 10 ? many : one));
  }
  return 'الآن';
}

/**
 * Gate for YouTube searches made by the discovery / music pages: at most 2 at a time and ~0.4 s apart, so the
 * TV never fires dozens of searches at once (YouTube treats bursts like that as a bot and starts asking the
 * whole connection to sign in).
 */
export const searchGate = (() => {
  let active = 0; let last = 0; const queue = [];
  const pump = () => {
    if (active >= 2 || !queue.length) return;
    const wait = Math.max(0, last + 400 - Date.now());
    if (wait) { setTimeout(pump, wait); return; }
    const { fn, ok, bad } = queue.shift();
    active++; last = Date.now();
    fn().then(ok, bad).finally(() => { active--; pump(); });
    pump();
  };
  return (fn) => new Promise((ok, bad) => { queue.push({ fn, ok, bad }); pump(); });
})();

/** true while YouTube is asking this connection to prove it is not a bot (heavy pages pause for 30 min). */
export const botPaused = () => Date.now() - (yt.botCheckAt || 0) < 30 * 60e3;

const HOME_TOPICS = ['music', 'gaming', 'news', 'sports'].map((k) => TOPICS[k]);

class YT {
  /** @type {Innertube} */
  tube = null;
  loggedIn = false;
  account = null;

  async init() {
    this.tube = await Innertube.create({
      cache: new UniversalCache(true),
      lang: settings.get('hl'),
      location: settings.get('gl'),
      generate_session_locally: false,
      retrieve_player: false, // the big player script loads in the background (only needed to play)
      fetch: boundFetch
    });
    const s = this.tube.session;
    this.playerReady = YTPlayer.create(s.cache, boundFetch)
      .then((p) => { s.player = p; return p; })
      .catch((e) => { console.warn('[player-js] failed', e?.message); this.playerReady = null; });
    s.on('auth', () => { this.loggedIn = true; });
    s.on('update-credentials', ({ credentials }) => { void credentials; s.oauth.cacheCredentials(); });
    s.on('auth-error', (e) => console.warn('[auth] error', e));
    // restore cached OAuth credentials (no prompt)
    try {
      const cached = await s.cache?.get('youtubei_oauth_credentials');
      if (cached) await s.signIn();
    } catch (e) { console.warn('[auth] restore failed', e); }
    this.loggedIn = s.logged_in;
    return this;
  }

  get session() { return this.tube.session; }

  /** Waits for (or retries) the background player-script download; needed before playback. */
  async ensurePlayer() {
    if (this.tube.session.player) return this.tube.session.player;
    if (!this.playerReady) {
      this.playerReady = YTPlayer.create(this.tube.session.cache, boundFetch)
        .then((p) => { this.tube.session.player = p; return p; })
        // forget a failed load so the next video tries again instead of reusing the failure
        .catch((e) => { this.playerReady = null; throw e; });
    }
    const p = await this.playerReady;
    if (!p) { this.playerReady = null; return this.ensurePlayer(); }
    return p;
  }

  async raw(endpoint, args) {
    const res = await this.tube.actions.execute(endpoint, { client: 'TV', ...args, parse: false });
    return res.data;
  }

  async home() {
    if (this.loggedIn) {
      const r = extract(await this.raw('/browse', { browseId: 'FEwhat_to_watch' }), { noShorts: true });
      if (r.items.length) return r;
    }
    return this.guestHome();
  }

  async guestHome(lastWatched) {
    const shelves = [];
    const jobs = [];
    if (lastWatched) {
      jobs.push(this.related(lastWatched).then((r) => r.items.length && shelves.push({ title: 'مقترح لك', items: r.items, order: 0 })));
    }
    HOME_TOPICS.forEach((t, i) => jobs.push(this.raw('/browse', { browseId: t.id }).then((j) => {
      const r = extract(j, { noShorts: true });
      for (const s of r.shelves.slice(0, 2)) {
        if (s.items.length > 2) shelves.push({ title: `${t.title}${s.title ? ' • ' + s.title : ''}`, items: s.items, order: i + 1 });
      }
    }).catch((e) => console.warn('[home] topic failed', t.id, e))));
    await Promise.all(jobs);
    shelves.sort((a, b) => a.order - b.order);
    return { shelves, items: shelves.flatMap((s) => s.items), continuation: null };
  }

  async search(query) {
    return extract(await this.raw('/search', { query }), { noShorts: !settings.get('shorts') });
  }

  async more(endpoint, continuation, client) {
    return extract(await this.raw(endpoint, { continuation, ...(client ? { client } : {}) }), { noShorts: !settings.get('shorts') });
  }

  /** Channel "Videos" tab, newest first (WEB client; TV home tab as fallback). */
  async channelVideos(id) {
    try {
      const r = extract(await this.raw('/browse', { browseId: id, params: 'EgZ2aWRlb3PyBgQKAjoA', client: 'WEB' }), { noShorts: true });
      r.items = r.items.filter((i) => i.type === 'video');
      if (r.items.length) { r.shelves = [{ title: '', items: r.items }]; r.client = 'WEB'; return r; }
    } catch (e) { console.warn('[channel] videos tab failed', e?.message); }
    return this.channel(id);
  }

  /**
   * A channel's latest long-form uploads with exact publish times, from YouTube's own RSS feed of the
   * "UULF" playlist (uploads without Shorts). Same origin, no extra permissions.
   */
  async rss(channelId) {
    const { entries } = await this.rssFeed(`playlist_id=UULF${channelId.slice(2)}`);
    return entries.map((e) => ({ ...e, channelId }));
  }

  /** An album / playlist feed: { owner, entries } (owner = the feed's author, e.g. "Singer - Topic"). */
  rssPlaylist(playlistId) { return this.rssFeed(`playlist_id=${playlistId}`); }

  async rssFeed(query) {
    const res = await boundFetch(`/feeds/videos.xml?${query}`);
    if (!res.ok) throw new Error('rss ' + res.status);
    const xml = await res.text();
    const tag = (e, t) => (e.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1] || '';
    const un = (x) => x.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const entries = [];
    for (const e of xml.match(/<entry>[\s\S]*?<\/entry>/g) || []) {
      const id = tag(e, 'yt:videoId'); const at = Date.parse(tag(e, 'published'));
      if (!id || !at || /\/shorts\//.test(e)) continue;
      entries.push({ type: 'video', id, title: un(tag(e, 'title')), sub: un(tag(tag(e, 'author'), 'name')), publishedAt: at, meta: '', thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, duration: '' });
    }
    const head = xml.split('<entry>')[0];
    const owner = un(tag(tag(head, 'author'), 'name')) || entries[0]?.sub || '';
    return { owner, entries };
  }

  /**
   * Recent uploads of a list of channels, merged into ONE list sorted by publish time (newest first across
   * all channels). Up to `per` videos per channel from the last `days` days. Exact times via RSS; a channel
   * whose feed fails falls back to its Videos tab (relative date text).
   */
  async uploadsOf(channels, { per = 3, days = 30 } = {}) {
    const out = [];
    await Promise.all(channels.map(async (c) => {
      let vids = [];
      try { vids = await this.rss(c.channelId); } catch (e) {
        try {
          const r = await this.channelVideos(c.channelId);
          if (r.client === 'WEB') vids = r.items.filter((i) => i.type === 'video' && !i.live && !i.short);
        } catch { /* skip channel */ }
      }
      let n = 0;
      for (const v of vids) {
        const age = itemAge(v);
        if (age > days * 86400 || n >= per) continue;
        n++;
        out.push({ ...v, sub: v.sub || c.name, age, meta: v.publishedAt ? relTime(age) : v.meta });
      }
    }));
    out.sort((a, b) => a.age - b.age);
    return out;
  }

  /** Favourites: the newest video of each hearted channel (one per channel), sorted newest first across channels. */
  async favorites() {
    const out = await this.uploadsOf(favorites.list(), { per: 1, days: 3650 });
    return { shelves: [{ title: '', items: out }], items: out, continuation: null };
  }

  /**
   * الجديد: recent uploads of subscriptions (when signed in) and of channels the user watched, in ONE list
   * sorted by publish time, newest first across all channels (the newest video of each channel).
   */
  async latest() {
    const seen = new Set(); const out = [];
    const push = (it) => { if (!seen.has(it.id)) { seen.add(it.id); out.push(it); } };
    const subsIds = new Set();
    if (this.loggedIn) {
      try {
        const r = await this.subscriptions(); // YouTube's own feed, already newest first
        const perCh = new Map();
        for (const it of r.items) {
          if (it.type !== 'video' || it.live || it.short) continue;
          const k = it.channelId || it.sub; const n = perCh.get(k) || 0;
          if (n >= 1) continue;
          perCh.set(k, n + 1); if (it.channelId) subsIds.add(it.channelId);
          push({ ...it, age: itemAge(it) });
        }
      } catch (e) { console.warn('[latest] subs', e?.message); }
    }
    const watched = history.channels().filter((c) => !subsIds.has(c.channelId)).slice(0, 25);
    for (const it of await this.uploadsOf(watched, { per: 1, days: 3650 })) push(it);
    out.sort((a, b) => a.age - b.age);
    return { shelves: [{ title: '', items: out }], items: out, continuation: null };
  }

  /** Latest football match highlights: YouTube search sorted by upload date (videos only), newest first. */
  async highlights() {
    const queries = ['ملخص مباراة', 'ملخص واهداف مباراة'];
    const res = await Promise.all(queries.map((query) =>
      this.raw('/search', { query, params: 'CAISAhAB', client: 'WEB' }).then((j) => extract(j, { noShorts: true }).items)
        .catch((e) => { console.warn('[highlights]', e?.message); return []; })));
    const seen = new Set(); const out = [];
    for (const it of res.flat()) {
      if (it.type !== 'video' || it.live || it.short || seen.has(it.id)) continue;
      seen.add(it.id); out.push({ ...it, age: ageOf(it.meta) });
    }
    out.sort((a, b) => a.age - b.age);
    return { shelves: [{ title: '', items: out }], items: out, continuation: null };
  }

  async channel(id) {
    return extract(await this.raw('/browse', { browseId: id }), { noShorts: !settings.get('shorts') });
  }

  async playlist(id) {
    return extract(await this.raw('/browse', { browseId: id.startsWith('VL') ? id : 'VL' + id }));
  }

  async related(videoId) {
    const j = await this.raw('/next', { videoId });
    const r = extract(j, { noShorts: true });
    r.items = r.items.filter((i) => i.type === 'video' && i.id !== videoId);
    r.details = videoDetails(j);
    return r;
  }

  async topic(key) {
    return extract(await this.raw('/browse', { browseId: TOPICS[key].id }), { noShorts: !settings.get('shorts') });
  }

  async channels() {
    return extract(await this.raw('/browse', { browseId: 'FEchannels' }));
  }

  async comments(token) {
    return comments(await this.raw('/next', { continuation: token }));
  }

  // ---- account actions (TV client accepts the OAuth session)
  like(videoId) { return this.raw('/like/like', { target: { videoId } }); }
  dislike(videoId) { return this.raw('/like/dislike', { target: { videoId } }); }
  unlike(videoId) { return this.raw('/like/removelike', { target: { videoId } }); }
  subscribe(channelId) { return this.raw('/subscription/subscribe', { channelIds: [channelId], params: 'EgIIAhgA' }); }
  unsubscribe(channelId) { return this.raw('/subscription/unsubscribe', { channelIds: [channelId], params: 'CgIIAhgA' }); }
  watchLater(videoId) {
    return this.raw('/browse/edit_playlist', { playlistId: 'WL', actions: [{ addedVideoId: videoId, action: 'ACTION_ADD_VIDEO' }] });
  }

  async subscriptions() {
    return extract(await this.raw('/browse', { browseId: 'FEsubscriptions' }), { noShorts: !settings.get('shorts') });
  }

  async history() {
    return extract(await this.raw('/browse', { browseId: 'FEhistory' }), { noShorts: true });
  }

  async library() {
    return extract(await this.raw('/browse', { browseId: 'FElibrary' }));
  }

  async suggestions(q) {
    if (!q) return [];
    try {
      const r = await this.tube.getSearchSuggestions(q);
      return r.slice(0, 8);
    } catch { return []; }
  }

  /** Starts the TV device-code sign in. onCode({verification_url,user_code}) is called with the code. */
  signIn(onCode) {
    return new Promise((resolve, reject) => {
      const s = this.session;
      const pending = (d) => onCode(d);
      s.on('auth-pending', pending);
      s.once('auth', async () => {
        this.loggedIn = true;
        try { await s.oauth.cacheCredentials(); } catch { /* ignore */ }
        resolve();
      });
      s.once('auth-error', reject);
      s.signIn().catch(reject);
    });
  }

  async signOut() {
    try { await this.session.signOut(); } catch { /* ignore */ }
    try { await this.session.oauth.removeCache(); } catch { /* ignore */ }
    this.loggedIn = false;
  }
}

export const yt = new YT();
