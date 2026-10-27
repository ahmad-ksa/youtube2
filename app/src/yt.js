// InnerTube access through youtubei.js (runs inside the youtube.com origin, so no CORS issues).
import { Innertube, Platform, UniversalCache, Player as YTPlayer } from 'youtubei.js/web';
import { extract, videoDetails, comments } from './extract.js';
import { settings, history, favorites } from './store.js';

Platform.shim.eval = async (data) => new Function(data.output)();
// webOS' browser throws "Illegal invocation" when fetch is called with another `this`.
const boundFetch = (input, init) => window.fetch(input, init);
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

  /** Newest video of each channel the user follows (subscriptions) or watched: one per channel, newest first. */
  async latest() {
    const out = []; const ids = new Set(); const names = new Set();
    const add = (it, chId, name) => {
      const n = name || it.sub || '';
      if ((chId && ids.has(chId)) || (n && names.has(n))) return;
      if (chId) ids.add(chId); if (n) names.add(n);
      out.push({ ...it, sub: it.sub || n });
    };
    if (this.loggedIn) {
      try {
        const r = await this.subscriptions(); // already newest first -> first video of each channel = its latest
        for (const it of r.items) if (it.type === 'video' && !it.live && !it.short) add(it, '', it.sub);
      } catch (e) { console.warn('[latest] subs', e?.message); }
    }
    const watched = history.channels().filter((c) => !ids.has(c.channelId) && !(c.name && names.has(c.name))).slice(0, 20);
    await Promise.all(watched.map((c) => this.channelVideos(c.channelId).then((r) => {
      if (r.client !== 'WEB') return; // only the real "newest first" videos tab
      const v = r.items.find((i) => i.type === 'video' && !i.live && !i.short);
      if (v) add(v, c.channelId, c.name);
    }).catch(() => { /* skip channel */ })));
    out.forEach((i) => { i.age = ageOf(i.meta); });
    out.sort((a, b) => a.age - b.age);
    return { shelves: [{ title: '', items: out }], items: out, continuation: null };
  }

  /** Favourites: the newest video of each hearted channel, newest first. */
  async favorites() {
    const out = [];
    await Promise.all(favorites.list().map((c) => this.channelVideos(c.channelId).then((r) => {
      const v = r.items.find((i) => i.type === 'video' && !i.live && !i.short);
      if (v) out.push({ ...v, sub: v.sub || c.name, age: ageOf(v.meta) });
    }).catch(() => { /* skip channel */ })));
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
