// Main TV UI: sidebar + pages of rows/grids, layer stack, remote key routing.
import { yt, TOPICS } from './yt.js';
import { exploreWorld, exploreArab, trendWorld, trendArab, trendMusic, topicByDate } from './discover.js';
import { musicPage } from './music.js';
import { dearrow } from './dearrow.js';
import { Player } from './player.js';
import { settings, history, favorites, searches, PRESETS, presetLabel, presetValue, setPreset } from './store.js';
import { sponsorblock } from './sponsorblock.js';
import { KEY, dirOf, isBack, isTyping, findNext, focus, current } from './nav.js';
import { h, esc, toast } from './dom.js';
import { ICON } from './icons.js';

const NAV = [
  ['search', '🔍', 'بحث'],
  ['home', '🏠', 'الرئيسية'],
  ['fav', '❤️', 'المفضلة'],
  ['new', '🆕', 'الجديد'],
  ['exploreWorld', '🌍', 'استكشف العالم'],
  ['exploreArab', '🕌', 'استكشف العرب'],
  ['trendWorld', '🔥', 'تريند العالم'],
  ['trendArab', '📈', 'الترند العربي'],
  ['subs', '📺', 'الاشتراكات'],
  ['channels', '👥', 'القنوات'],
  ['history', '🕘', 'السجل'],
  ['library', '📚', 'المكتبة'],
  ['arabMusic', '🎶', 'الموسيقى العربية'],
  ['worldMusic', '🎸', 'الموسيقى الأجنبية'],
  ['trendMusic', '🎧', 'تريند الأغاني العالمي'],
  ['music', '🎵', 'موسيقى'],
  ['gaming', '🎮', 'ألعاب'],
  ['news', '📰', 'أخبار'],
  ['sports', '⚽', 'رياضة'],
  ['highlights', '🏆', 'ملخصات المباريات'],
  ['live', '🔴', 'مباشر'],
  ['refresh', '🔄', 'تحديث'],
  ['settings', '⚙', 'الإعدادات'],
  ['account', '👤', 'الحساب']
];

export class App {
  constructor() {
    this.cardData = new WeakMap();
    this.layers = [];
    this.pages = [];
    this.root = h(`<div id="app">
      <aside class="sidebar layer-part">
        <div class="brand">YouTube <b>LG</b></div>
        <nav class="nav-scroll">${NAV.map(([id, icon, label]) => `<button class="f nav-item" data-nav="${id}"><span class="ic">${icon}</span><span class="lb">${label}</span></button>`).join('')}</nav>
      </aside>
      <main class="content scroll-y"><div class="page-head"></div><div class="page"></div><div class="loading"><i></i></div></main>
      <div class="modal"><div class="box"><div class="m-title"></div><div class="m-body"></div><div class="m-items scroll-y"></div></div></div>
    </div>`);
    this.sidebar = this.root.querySelector('.sidebar');
    this.content = this.root.querySelector('.content');
    this.pageEl = this.root.querySelector('.page');
    this.headEl = this.root.querySelector('.page-head');
    this.modal = this.root.querySelector('.modal');
    this.base = { el: this.root, onKey: (e) => this.onBaseKey(e) };
    this.layers.push(this.base);
    this.player = new Player(this);

    this.sidebar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-nav]');
      if (!b) return;
      clearTimeout(this.navTimer);
      if (b.dataset.nav === 'refresh') { this.refreshPage(); return; }
      if (b.dataset.nav === this.currentNav && b.dataset.nav !== 'search' && !['settings', 'account'].includes(b.dataset.nav)) {
        // pressing the section you are already on refreshes it
        this.refreshPage(true);
        return;
      }
      if (b.dataset.nav === this.currentNav) {
        // section already shown (opened on highlight): OK jumps into it
        this.preview = false;
        const target = b.dataset.nav === 'search' ? this.headEl.querySelector('.search-input') : this.content.querySelector('.f');
        if (target) focus(target);
        else if (!yt.loggedIn && ['subs', 'library', 'channels'].includes(b.dataset.nav)) this.needLogin();
      } else this.go(b.dataset.nav);
    });
    this.content.addEventListener('click', (e) => {
      const c = e.target.closest('.card'); if (c) this.activate(this.cardData.get(c));
    });
    document.addEventListener('keydown', (e) => this.onKey(e), true);
    this.content.addEventListener('scroll', () => this.maybeMore(), { passive: true });
    // YouTube-TV style rail: collapsed to icons, expands while focused
    document.addEventListener('navfocus', (e) => {
      const inSide = this.sidebar.contains(e.detail);
      this.sidebar.classList.toggle('open', inSide);
      clearTimeout(this.navTimer);
    });
  }

  mount() {
    document.body.appendChild(this.root);
    document.body.appendChild(this.player.el);
  }

  // ------------------------------------------------------------------ layers

  isTop(layer) { return this.layers[this.layers.length - 1] === layer; }

  push(layer) {
    const top = this.layers[this.layers.length - 1];
    top.lastFocus = current();
    this.layers.push(layer);
    layer.el.classList.add('shown');
    // free the GPU while video plays: hide the browse UI behind the player
    if (layer === this.player) this.root.style.visibility = 'hidden';
  }

  pop(layer) {
    const i = this.layers.indexOf(layer);
    if (i <= 0) return;
    this.layers.splice(i, 1);
    layer.el.classList.remove('shown');
    if (layer === this.player) this.root.style.visibility = '';
    const top = this.layers[this.layers.length - 1];
    if (top === this.base && this.pages.length && this.pages[this.pages.length - 1].refreshOnReturn) this.reload();
    focus(top.lastFocus && document.contains(top.lastFocus) ? top.lastFocus : findNext(top.el, null));
  }

  onKey(e) {
    if (this.modal.classList.contains('on')) { this.onModalKey(e); e.preventDefault(); e.stopPropagation(); return; }
    const top = this.layers[this.layers.length - 1];
    if (top.onKey(e)) { e.preventDefault(); e.stopPropagation(); }
  }

  // ------------------------------------------------------------------ base view keys

  onBaseKey(e) {
    const k = e.keyCode;
    const cur = current();
    if (isTyping()) {
      if (k === KEY.ENTER) { this.runSearch(cur.value); return true; }
      if (k === KEY.DOWN || k === KEY.UP || k === KEY.LEFT || k === KEY.RIGHT) { cur.blur(); }
      else if (isBack(e) && e.keyCode !== KEY.BACKSPACE) { cur.blur(); }
      else return false;
    }
    if (isBack(e)) { this.back(); return true; }
    const d = dirOf(k);
    if (d) {
      if (!cur || !this.root.contains(cur)) { focus(findNext(this.root, null)); return true; }
      // inside a horizontal row: move card by card (RTL: right = previous card); leave to the
      // sidebar only from the first card, never by skipping cards that are scrolled out of view
      const rowBox = cur.closest('.row-items');
      if (rowBox && (d === 'left' || d === 'right')) {
        const sib = d === 'right' ? cur.previousElementSibling : cur.nextElementSibling;
        if (sib) { focus(sib); return true; }
        if (d === 'left' || e.repeat) return true; // holding the key stops at the first card
        this.lastContentFocus = cur;
        focus(this.sidebar.querySelector('.nav-item.on') || this.sidebar.querySelector('.f'));
        return true;
      }
      const inSidebar = this.sidebar.contains(cur);
      const scope = inSidebar && (d === 'up' || d === 'down') ? this.sidebar : this.root;
      let next = findNext(scope, cur, d);
      // leaving the sidebar (left in RTL) always returns to the card you came from
      if (inSidebar && d === 'left') next = this.pageFocusTarget() || next;
      else if (inSidebar && next && !this.sidebar.contains(next)) next = this.pageFocusTarget() || next;
      if (!inSidebar && d === 'right' && (!next || this.sidebar.contains(next))) {
        // RTL: the sidebar is on the right; enter it at the active item
        this.lastContentFocus = cur;
        next = this.sidebar.querySelector('.nav-item.on') || this.sidebar.querySelector('.f');
      } else if (!inSidebar && next && this.sidebar.contains(next)) next = null;
      if (next) focus(next);
      if (next && !this.sidebar.contains(next)) this.maybeMore(next);
      return true;
    }
    if (k === KEY.ENTER) { cur?.click(); return true; }
    if (k === KEY.RED) { this.go('search'); return true; }
    if (k === KEY.GREEN) { this.go('settings'); return true; }
    return false;
  }

  pageFocusTarget() {
    if (this.lastContentFocus && this.content.contains(this.lastContentFocus)) return this.lastContentFocus;
    return this.content.querySelector('.f');
  }

  back() {
    const cur = current();
    if (this.pages.length > 1) { this.pages.pop(); this.render(this.pages[this.pages.length - 1], true); return; }
    if (cur && this.content.contains(cur)) { this.lastContentFocus = cur; focus(this.sidebar.querySelector('.nav-item.on') || this.sidebar.querySelector('.f')); return; }
    this.confirm('الخروج من التطبيق؟', () => window.close());
  }

  // ------------------------------------------------------------------ pages

  /** preview = opened just by moving focus in the sidebar (keep focus there, no popups). */
  go(id, preview) {
    this.preview = !!preview;
    this.currentNav = id;
    this.sidebar.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.nav === id));
    this.pages = [];
    switch (id) {
      case 'home': {
        // show last session's home instantly, then refresh it in the background
        let cached = null;
        try { cached = JSON.parse(localStorage.getItem('ytlg.homeCache') || 'null'); } catch { cached = null; }
        const page = { title: '', mode: 'rows', refreshOnReturn: false };
        if (cached?.shelves?.length) {
          page.instant = cached;
          page.load = () => this.loadHome().then((fresh) => { this.saveHome(fresh); return fresh; });
        } else page.load = () => this.loadHome().then((fresh) => { this.saveHome(fresh); return fresh; });
        this.open(page);
        break;
      }
      case 'new':
        this.open({ title: 'الجديد', load: async () => {
          const r = await yt.latest();
          if (!r.items.length) toast('شاهد فيديوهات أو سجّل دخولك ليظهر جديد قنواتك', 5000);
          return r;
        }, mode: 'grid', refreshOnReturn: true }); break;
      case 'fav':
        this.open({ title: 'المفضلة', load: async () => {
          if (!favorites.list().length) toast('اضغط زر القلب ❤ أثناء مشاهدة فيديو لإضافة قناته للمفضلة', 5000);
          return yt.favorites();
        }, mode: 'grid', refreshOnReturn: true }); break;
      case 'exploreWorld': case 'exploreArab': case 'trendWorld': case 'trendArab': case 'trendMusic': {
        const P = {
          exploreWorld: ['استكشف العالم', 'أوروبا وأمريكا وروسيا وكوريا — قنوات ومواضيع متنوعة', exploreWorld],
          exploreArab: ['استكشف العرب', 'من كل الدول العربية — قنوات ومواضيع متنوعة', exploreArab],
          trendWorld: ['تريند العالم', 'الأكثر مشاهدة حول العالم الآن', trendWorld],
          trendArab: ['الترند العربي', 'الأكثر مشاهدة في العالم العربي الآن', trendArab],
          trendMusic: ['تريند الأغاني العالمي', 'أكثر الأغاني مشاهدة في العالم الآن', trendMusic]
        }[id];
        this.open({ title: P[0], head: `<h1>${P[0]}</h1><div class="head-note">${P[1]} — من الأحدث إلى الأقدم</div>`,
          load: () => P[2](), mode: 'grid', emptyText: 'تعذّر جلب الفيديوهات، جرّب التحديث' });
        break;
      }
      case 'arabMusic': case 'worldMusic': {
        const title = id === 'arabMusic' ? 'الموسيقى العربية' : 'الموسيقى الأجنبية';
        const pg = { title, head: `<h1>${title}</h1><div class="head-note">أحدث أغنية وأحدث ألبوم من كل مطرب — من الأحدث إلى الأقدم</div>`,
          mode: 'grid', emptyText: 'تعذّر جلب الأغاني، جرّب التحديث' };
        // the sidebar "refresh" button reloads with fresh data instead of the 30-min cache
        const kind = id === 'arabMusic' ? 'arab' : 'world';
        pg.load = () => { const fresh = pg.loaded; pg.loaded = true; return musicPage(kind, { fresh }); };
        this.open(pg);
        break;
      }
      case 'highlights':
        this.open({ title: 'ملخصات المباريات', load: () => yt.highlights(), mode: 'grid', refreshOnReturn: true }); break;
      case 'search': this.openSearch(); break;
      case 'subs':
        if (!yt.loggedIn) return this.needLogin();
        this.open({ title: 'الاشتراكات', load: () => yt.subscriptions(), mode: 'grid', endpoint: '/browse' }); break;
      case 'history':
        this.open({
          title: 'السجل',
          head: `<h1>السجل</h1><div class="head-actions"><button class="f clear-history">🗑 مسح السجل</button></div>`,
          headInit: (head) => head.querySelector('.clear-history').addEventListener('click', () => this.clearHistory()),
          load: async () => {
            if (yt.loggedIn) { try { const r = await yt.history(); if (r.items.length) return r; } catch (e) { console.warn(e); } }
            return { shelves: [{ title: '', items: history.list() }], continuation: null };
          },
          mode: 'grid', endpoint: '/browse', refreshOnReturn: true
        }); break;
      case 'library':
        if (!yt.loggedIn) return this.needLogin();
        this.open({ title: 'قوائم التشغيل', load: () => yt.library(), mode: 'rows' }); break;
      case 'channels':
        if (!yt.loggedIn) return this.needLogin();
        this.open({ title: 'القنوات', load: () => yt.channels(), mode: 'grid', endpoint: '/browse' }); break;
      case 'gaming': case 'news':
        this.open({ title: TOPICS[id].title, load: () => topicByDate(id), mode: 'grid', refreshOnReturn: false }); break;
      case 'music': case 'sports': case 'live':
        this.open({ title: TOPICS[id].title, load: () => yt.topic(id), mode: 'rows' }); break;
      case 'settings': this.openSettings(); break;
      case 'account': this.openAccount(); break;
    }
  }

  saveHome(data) {
    try {
      const shelves = (data?.shelves || []).slice(0, 8).map((sh) => ({ title: sh.title, items: sh.items.slice(0, 15) }));
      if (shelves.length) localStorage.setItem('ytlg.homeCache', JSON.stringify({ shelves }));
    } catch { /* storage unavailable */ }
  }

  async loadHome() {
    const latest = yt.latest().catch((e) => { console.warn('[home] latest', e?.message); return null; });
    const fv = favorites.list().length ? yt.favorites().catch(() => null) : Promise.resolve(null);
    const hl = yt.highlights().catch((e) => { console.warn('[home] highlights', e?.message); return null; });
    const withNew = async (r) => {
      const [n, m, f] = await Promise.all([latest, hl, fv]);
      const shelves = [...(r.shelves || [])];
      // order: المفضلة, الجديد, مقترح لك, ملخصات المباريات, then the rest
      const sug = shelves.findIndex((x) => x.title === 'مقترح لك');
      if (m?.items.length) shelves.splice(sug >= 0 ? sug + 1 : 0, 0, { title: 'ملخصات المباريات', items: m.items.slice(0, 20) });
      if (n?.items.length) shelves.unshift({ title: 'الجديد', items: n.items.slice(0, 20) });
      if (f?.items.length) shelves.unshift({ title: 'المفضلة', items: f.items });
      r.shelves = shelves;
      r.items = shelves.flatMap((x) => x.items);
      return r;
    };
    const last = history.list()[0];
    if (yt.loggedIn) {
      try { const r = await yt.home(); if (r.items.length) return withNew(r); } catch (e) { console.warn('[home]', e); }
    }
    return withNew(await yt.guestHome(last?.id));
  }

  open(page) {
    this.pages.push(page);
    this.render(page);
  }

  async render(page, restoring) {
    const token = (this.renderToken = (this.renderToken || 0) + 1);
    this.headEl.innerHTML = page.head || (page.title ? `<h1>${esc(page.title)}</h1>` : '');
    page.headInit?.(this.headEl);
    if (page.draw) { this.pageEl.innerHTML = ''; page.draw(); return; }
    if (restoring && page.cache) {
      this.drawPage(page, page.cache);
      focus(page.lastFocus && document.contains(page.lastFocus) ? page.lastFocus : this.content.querySelector('.f'));
      return;
    }
    this.pageEl.innerHTML = '';
    if (!page.load) return;
    if (page.instant) {
      const inst = page.instant; page.instant = null;
      this.drawPage(page, inst);
      if (!this.sidebar.contains(current()) && !this.headEl.contains(current())) focus(this.content.querySelector('.page .f'));
      // refresh quietly; swap in fresh rows only if the user is not browsing them yet
      page.load().then((fresh) => {
        if (token !== this.renderToken || !fresh?.shelves?.length) return;
        page.cache = fresh;
        if (!this.content.contains(current()) || current() === this.content.querySelector('.page .f')) {
          const wasFocused = this.content.contains(current());
          this.drawPage(page, fresh);
          if (wasFocused) focus(this.content.querySelector('.page .f'));
        }
      }).catch((e) => console.warn('[home refresh]', e));
      return;
    }
    this.content.classList.add('busy');
    try {
      const data = await page.load();
      if (token !== this.renderToken) return;
      page.cache = data;
      page.continuation = page.mode === 'grid' ? (data.gridContinuation || data.continuation) : data.continuation;
      if (data.more) { page.more = data.more; page.continuation = 'more'; }
      this.drawPage(page, data);
      if (!data.items?.length && !data.shelves?.some((s) => s.items.length)) {
        this.pageEl.innerHTML = `<div class="empty">${esc(page.emptyText || 'لا يوجد محتوى')}</div>`;
      }
      if (!this.sidebar.contains(current()) && !this.headEl.contains(current())) focus(this.content.querySelector('.page .f') || this.content.querySelector('.f'));
    } catch (e) {
      console.error('[page]', e);
      if (token === this.renderToken) this.pageEl.innerHTML = `<div class="empty">تعذّر التحميل: ${esc(e?.message || e)}<br><button class="f retry">إعادة المحاولة</button></div>`;
      this.pageEl.querySelector('.retry')?.addEventListener('click', () => this.render(page));
    } finally {
      if (token === this.renderToken) this.content.classList.remove('busy');
    }
  }

  reload() { const p = this.pages[this.pages.length - 1]; if (p) { p.cache = null; this.render(p); } }

  /** Fresh reload of the page on screen (no cached rows); jump into it when asked. */
  async refreshPage(enter) {
    const p = this.pages[this.pages.length - 1];
    if (!p?.load) { if (enter) focus(this.content.querySelector('.f')); return; }
    toast('جاري التحديث…', 1500);
    p.cache = null; p.instant = null;
    await this.render(p);
    if (enter || !this.sidebar.contains(current())) focus(this.content.querySelector('.page .f'));
  }

  drawPage(page, data) {
    this.pageEl.innerHTML = '';
    page.lastFocus = null;
    if (page.mode === 'grid') {
      const grid = h('<div class="grid"></div>');
      for (const it of data.shelves.flatMap((s) => s.items)) grid.appendChild(this.card(it));
      this.pageEl.appendChild(grid);
    } else {
      for (const s of data.shelves) this.pageEl.appendChild(this.row(s));
    }
  }

  row(shelf) {
    const r = h(`<section class="row"><div class="row-title">${esc(shelf.title || '')}</div><div class="row-items"></div></section>`);
    const box = r.querySelector('.row-items');
    for (const it of shelf.items) box.appendChild(this.card(it));
    return r;
  }

  card(it) {
    const isCh = it.type === 'channel';
    const c = h(`<button class="f card ${it.type}">
      <div class="thumb"><img loading="lazy" src="${esc(it.thumb)}" alt="">${it.duration ? `<span class="dur${it.live ? ' live' : ''}">${esc(it.duration)}</span>` : ''}${it.type === 'playlist' ? `<span class="pl">${ICON.list}</span>` : ''}</div>
      <div class="info"><div class="title">${esc(it.title)}</div>${it.sub && !isCh ? `<div class="sub">${esc(it.sub)}</div>` : ''}${it.meta || (isCh && it.sub) ? `<div class="meta">${esc(isCh ? it.sub : it.meta)}</div>` : ''}</div>
    </button>`);
    c.querySelector('img').addEventListener('error', function () { if (it.type === 'video' && !this.dataset.fb) { this.dataset.fb = 1; this.src = `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`; } });
    this.cardData.set(c, it);
    if (it.type === 'video') dearrow.watch(c, it.id);
    return c;
  }

  activate(it) {
    if (!it) return;
    const page = this.pages[this.pages.length - 1];
    if (page) page.lastFocus = current();
    if (it.type === 'video') {
      // inside a playlist page: play the rest of the list in order
      if (page?.playlist) {
        const cards = [...this.pageEl.querySelectorAll('.card.video')].map((c) => this.cardData.get(c));
        const i = cards.findIndex((x) => x === it);
        this.player.open(it, cards.slice(i + 1));
      } else this.player.open(it, []);
    }
    else if (it.type === 'channel') this.openChannel(it.id, it.title);
    else if (it.type === 'playlist') this.openPlaylist(it);
  }

  openPlaylist(it) {
    const page = { title: it.title, load: () => yt.playlist(it.id), mode: 'grid', endpoint: '/browse', playlist: true };
    page.head = `<h1>${esc(it.title)}</h1><div class="head-actions"><button class="f play-all">${ICON.play} تشغيل الكل</button></div>`;
    page.headInit = (head) => head.querySelector('.play-all').addEventListener('click', () => {
      const items = [...this.pageEl.querySelectorAll('.card.video')].map((c) => this.cardData.get(c));
      if (items.length) this.player.open(items[0], items.slice(1));
    });
    this.open(page);
  }

  openChannel(id, title) {
    const page = this.pages[this.pages.length - 1];
    if (page) page.lastFocus = current();
    const pg = { title: title || 'القناة', mode: 'grid', endpoint: '/browse' };
    pg.load = async () => {
      const r = await yt.channelVideos(id);
      pg.client = r.client;
      if (!r.client) pg.mode = 'rows';
      return r;
    };
    this.open(pg);
  }

  async maybeMore(focused) {
    const page = this.pages[this.pages.length - 1];
    if (!page || !page.continuation || this.loadingMore || (page.mode !== 'grid' && page.mode !== 'rows')) return;
    const el = focused || current();
    let nearEnd;
    const grid = this.pageEl.querySelector('.grid');
    if (page.mode === 'grid') {
      if (!grid) return;
      const idx = Array.prototype.indexOf.call(grid.children, el);
      nearEnd = idx >= 0 ? idx >= grid.children.length - 10 : this.content.scrollTop + this.content.clientHeight > this.content.scrollHeight - 600;
    } else {
      const rows = [...this.pageEl.querySelectorAll('.row')];
      const ri = rows.indexOf(el?.closest?.('.row'));
      nearEnd = ri >= rows.length - 2;
    }
    if (!nearEnd) return;
    this.loadingMore = true;
    try {
      let r;
      if (page.more) { // date-windowed feeds (Explore / Trending): next, older batch
        r = await page.more();
        if (page !== this.pages[this.pages.length - 1]) return;
        if (r.done) page.continuation = null;
      } else {
        r = await yt.more(page.endpoint || '/browse', page.continuation, page.client);
        if (page !== this.pages[this.pages.length - 1]) return;
        const nextTok = page.mode === 'grid' ? (r.gridContinuation || r.continuation) : r.continuation;
        page.continuation = nextTok !== page.continuation ? nextTok : null;
      }
      if (page.mode === 'grid') {
        const known = new Set([...grid.children].map((c) => this.cardData.get(c)?.id));
        for (const it of r.items) if (!known.has(it.id)) grid.appendChild(this.card(it));
      } else {
        for (const s of r.shelves) if (s.items.length) this.pageEl.appendChild(this.row(s));
      }
      if (page.cache) page.cache = null;
    } catch (e) { console.warn('[more]', e); page.continuation = null; } finally { this.loadingMore = false; }
  }

  // ------------------------------------------------------------------ search

  openSearch() {
    const page = {
      title: '', mode: 'grid', endpoint: '/search',
      head: `<div class="search-bar"><input class="f search-input" type="text" placeholder="ابحث في يوتيوب…" autocomplete="off"><button class="f search-go">${ICON.search}</button></div><div class="suggest"></div>`,
      headInit: (head) => {
        const input = head.querySelector('input');
        input.value = page.query || '';
        let t;
        // Voice dictation (keyboard mic / AI button) drops a whole phrase at once, sometimes without an
        // 'input' event. Watch the value: a jump of several characters = dictated -> search automatically.
        let prev = input.value, voiceT;
        const check = () => {
          const v = input.value;
          if (v === prev) return;
          const jump = v.length - prev.length;
          prev = v;
          clearTimeout(voiceT);
          if (jump > 2 && v.trim()) voiceT = setTimeout(() => { if (input.value.trim() && input.value === v) this.runSearch(input.value); }, 900);
        };
        input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(async () => this.drawSuggestions(await yt.suggestions(input.value)), 250);
          check();
        });
        input.addEventListener('change', check);
        input.addEventListener('compositionend', check);
        const poll = setInterval(() => { if (!document.contains(input)) clearInterval(poll); else check(); }, 300);
        input.addEventListener('keydown', (e) => { if (e.keyCode === 13) { e.preventDefault(); this.runSearch(input.value); } });
        head.querySelector('.search-go').addEventListener('click', () => this.runSearch(input.value));
        if (!page.query) {
          this.drawSuggestions(searches.list(), true);
          if (!this.preview) setTimeout(() => focus(input), 50);
        }
      },
      load: null
    };
    this.searchPage = page;
    this.open(page);
  }

  /** Search coming from the remote's microphone / global voice search. */
  voiceSearch(q) {
    if (!this.searchPage || this.pages[this.pages.length - 1] !== this.searchPage) this.go('search');
    setTimeout(() => this.runSearch(q), 50);
  }

  /** Voice: focus the search box; the TV dictates into it (AI / mic button or the keyboard's mic). */
  micSearch() {
    const input = this.headEl.querySelector('.search-input');
    if (!input) return;
    input.value = '';
    focus(input);
    try { input.click(); } catch { /* ignore */ }
    toast('اضغط مطوّلًا على زر AI في الريموت وتكلّم — البحث يبدأ تلقائيًا', 6000);
  }

  drawSuggestions(list, recent) {
    const box = this.headEl.querySelector('.suggest');
    if (!box) return;
    box.innerHTML = recent && list.length ? '<span class="sg-label">عمليات بحث سابقة:</span>' : '';
    for (const s of list) {
      const b = h(`<button class="f chip">${esc(s)}</button>`);
      b.addEventListener('click', () => this.runSearch(s));
      box.appendChild(b);
    }
  }

  runSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    const page = this.searchPage;
    searches.add(q);
    page.query = q;
    page.cache = null;
    page.load = () => yt.search(q);
    const input = this.headEl.querySelector('input');
    if (input) { input.value = q; input.blur(); }
    this.headEl.querySelector('.suggest').innerHTML = '';
    this.render(page).then(() => focus(this.pageEl.querySelector('.f')));
  }

  // ------------------------------------------------------------------ settings

  openSettings() {
    this.open({ title: 'الإعدادات', mode: 'list', draw: () => this.drawSettings() });
  }

  drawSettings() {
    const qLabel = { max: 'أعلى جودة', auto: 'تلقائي' };
    const codecLabel = { auto: 'تلقائي (AV1 ثم VP9)', av01: 'AV1', vp9: 'VP9', avc1: 'H.264 (أخف)' };
    const startLabel = { 480: '480p (الأسرع)', 720: '720p', 0: 'بدون — ابدأ مباشرة بالجودة القصوى' };
    const rows = [
      ['preset', 'الجودة القصوى', presetLabel(), PRESETS],
      ['autoQ', 'الجودة حسب سرعة الإنترنت', settings.get('autoQ') !== false ? 'تلقائي (ترتفع وتنزل)' : 'ثابتة على القصوى',
        [[true, 'تلقائي (ترتفع وتنزل)'], [false, 'ثابتة على القصوى']]],
      ['startQ', 'جودة البدء (أسرع تشغيل)', startLabel[settings.get('startQ')] || startLabel[480], Object.entries(startLabel).map(([v, l]) => [Number(v), l])],
      ['codec', 'الترميز المفضل', codecLabel[settings.get('codec')], Object.entries(codecLabel)],
      ['hdrOn', 'HDR', settings.get('hdrOn') ? 'مفعّل' : 'متوقف', [[true, 'مفعّل'], [false, 'متوقف']]],
      ['speed', 'السرعة الافتراضية', settings.get('speed') + 'x', [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => [s, s + 'x'])],
      ['buffer', 'حجم التخزين المؤقت', settings.get('buffer') + ' ثانية', [[30, '30 ثانية'], [60, '60 ثانية'], [120, '120 ثانية'], [240, '240 ثانية']]],
      ['autoplay', 'تشغيل التالي تلقائيًا', settings.get('autoplay') ? 'مفعّل' : 'متوقف', [[true, 'مفعّل'], [false, 'متوقف']]],
      ['shorts', 'إظهار الشورتس', settings.get('shorts') ? 'نعم' : 'لا', [[true, 'نعم'], [false, 'لا']]],
      ['sb', 'SponsorBlock (تخطي الرعايات)', settings.get('sb') ? 'مفعّل' : 'متوقف', [[true, 'مفعّل'], [false, 'متوقف']]],
      ['sbCats', 'ما يتم تخطيه', (settings.get('sbCats') || []).map(sponsorblock.label).join('، ') || 'لا شيء', 'multi'],
      ['seekStep', 'مقدار التقديم والترجيع', settings.get('seekStep') + ' ثانية', [[5, '5 ثوانٍ'], [10, '10 ثوانٍ'], [15, '15 ثانية'], [30, '30 ثانية']]],
      ['dearrow', 'DeArrow (عناوين بدون تضليل)', settings.get('dearrow') ? 'مفعّل' : 'متوقف', [[true, 'مفعّل'], [false, 'متوقف']]],
      ['dearrowThumbs', 'DeArrow للصور المصغّرة', settings.get('dearrowThumbs') ? 'مفعّل' : 'متوقف', [[true, 'مفعّل'], [false, 'متوقف']]],
      ['translate', 'الترجمة الآلية إلى', ({ '': 'إيقاف', ar: 'العربية', en: 'English', fr: 'Français', tr: 'Türkçe', ur: 'اردو', id: 'Indonesia', es: 'Español', de: 'Deutsch' })[settings.get('translate')] || settings.get('translate'),
        [['', 'إيقاف'], ['ar', 'العربية'], ['en', 'English'], ['fr', 'Français'], ['tr', 'Türkçe'], ['ur', 'اردو'], ['id', 'Indonesia'], ['es', 'Español'], ['de', 'Deutsch']]],
      ['captions', 'تشغيل الترجمة تلقائيًا بلغة', ({ '': 'إيقاف', ar: 'العربية', en: 'English' })[settings.get('captions')] || settings.get('captions'), [['', 'إيقاف'], ['ar', 'العربية'], ['en', 'English']]],
      ['hl', 'لغة المحتوى', settings.get('hl') === 'ar' ? 'العربية' : 'English', [['ar', 'العربية'], ['en', 'English']]],
      ['showLogs', 'سجل الأخطاء (للتشخيص)', '›', null],
      ['clearHistory', 'مسح السجل المحلي وعمليات البحث', '', null],
      ['about', 'الإصدار', 'v' + (typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'), null]
    ];
    this.pageEl.innerHTML = '<div class="settings"></div>';
    const box = this.pageEl.querySelector('.settings');
    for (const [key, label, value, opts] of rows) {
      const b = h(`<button class="f set-row"><span>${esc(label)}</span><b>${esc(value)}</b></button>`);
      b.addEventListener('click', () => {
        if (key === 'clearHistory') { history.clear(); searches.clear(); toast('تم مسح السجل'); return; }
        if (key === 'about') return;
        if (key === 'showLogs') { window.__ytlgLogs?.(); return; }
        if (opts === 'multi') return this.sbCatsMenu();
        this.menu(label, opts.map(([v, l]) => ({ value: v, label: l, on: key === 'preset' ? presetValue() === v : settings.get(key) === v })), (v) => {
          if (key === 'preset') setPreset(v); else settings.set(key, v);
          if (key === 'hl') toast('سيُطبّق بعد إعادة تشغيل التطبيق');
          const idx = [...box.children].indexOf(b);
          this.drawSettings();
          focus(this.pageEl.querySelector('.settings').children[idx]);
        });
      });
      box.appendChild(b);
    }
    if (!this.preview) focus(box.firstChild);
  }

  sbCatsMenu() {
    const cats = new Set(settings.get('sbCats') || []);
    const draw = () => this.menu('ما يتم تخطيه', Object.entries(sponsorblock.LABELS).map(([k, l]) => ({ value: k, label: (cats.has(k) ? '✓ ' : '   ') + l, on: cats.has(k) })), (v) => {
      if (cats.has(v)) cats.delete(v); else cats.add(v);
      settings.set('sbCats', [...cats]);
      setTimeout(draw, 0);
    }, () => this.drawSettings());
    draw();
  }

  // ------------------------------------------------------------------ account

  openAccount() {
    this.open({ title: 'الحساب', mode: 'list', draw: () => this.drawAccount() });
  }

  drawAccount() {
    const box = h('<div class="settings"></div>');
    this.pageEl.innerHTML = '';
    this.pageEl.appendChild(box);
    if (yt.loggedIn) {
      box.appendChild(h('<div class="note">أنت مسجّل الدخول. الاشتراكات والسجل وقوائم التشغيل متاحة.</div>'));
      const b = h('<button class="f set-row"><span>تسجيل الخروج</span><b></b></button>');
      b.addEventListener('click', () => this.confirm('تسجيل الخروج؟', async () => { await yt.signOut(); toast('تم تسجيل الخروج'); this.go('home'); }));
      box.appendChild(b);
    } else {
      box.appendChild(h('<div class="note">سجّل الدخول لعرض اشتراكاتك وسجلّك وقوائمك. التطبيق يعمل بدون تسجيل أيضًا.</div>'));
      const b = h('<button class="f set-row"><span>تسجيل الدخول بحساب Google</span><b>›</b></button>');
      b.addEventListener('click', () => this.login());
      box.appendChild(b);
    }
    if (!this.preview) focus(box.querySelector('.f'));
  }

  needLogin() {
    if (this.preview) {
      this.headEl.innerHTML = '';
      this.pageEl.innerHTML = '<div class="empty">هذه الصفحة تحتاج تسجيل الدخول — من صفحة <b>الحساب</b></div>';
      return;
    }
    this.confirm('هذه الصفحة تحتاج تسجيل الدخول. تسجّل الآن؟', () => this.login());
  }

  async login() {
    this.showModal('تسجيل الدخول', '<div class="code">جاري طلب الرمز…</div>', []);
    try {
      await yt.signIn(({ verification_url, user_code }) => {
        this.modal.querySelector('.m-body').innerHTML =
          `<div>من جوالك أو كمبيوترك افتح:</div><div class="url">${esc((verification_url || 'youtube.com/activate').replace(/^https?:\/\//, ''))}</div>
           <div>وأدخل هذا الرمز:</div><div class="code">${esc(user_code)}</div><div class="hint">تنتظر الشاشة حتى تكمل التسجيل…</div>`;
      });
      this.hideModal();
      toast('تم تسجيل الدخول ✓');
      this.go('home');
    } catch (e) {
      console.error('[login]', e);
      this.modal.querySelector('.m-body').innerHTML = `<div>تعذّر تسجيل الدخول: ${esc(e?.message || e)}</div>`;
    }
  }

  // ------------------------------------------------------------------ modal

  showModal(title, body, items, onClose) {
    this.modal.querySelector('.m-title').textContent = title;
    this.modal.querySelector('.m-body').innerHTML = body || '';
    const list = this.modal.querySelector('.m-items');
    list.innerHTML = '';
    let sel = null;
    for (const it of items) {
      const b = h(`<button class="f${it.on ? ' on' : ''}">${esc(it.label)}</button>`);
      b.addEventListener('click', () => it.pick());
      list.appendChild(b);
      if (it.on) sel = b;
    }
    this.modalReturn = current();
    this.modalOnClose = onClose;
    this.modal.classList.add('on');
    focus(sel || list.firstChild || null);
  }

  hideModal() {
    this.modal.classList.remove('on');
    const cb = this.modalOnClose; this.modalOnClose = null;
    if (this.modalReturn && document.contains(this.modalReturn)) focus(this.modalReturn);
    cb?.();
  }

  onModalKey(e) {
    if (isBack(e)) { this.hideModal(); return; }
    const d = dirOf(e.keyCode);
    if (d) { const n = findNext(this.modal, current(), d); if (n) focus(n); return; }
    if (e.keyCode === KEY.ENTER) current()?.click();
  }

  menu(title, options, onPick, onClose) {
    this.showModal(title, '', options.map((o) => ({ label: o.label, on: o.on, pick: () => { this.modalOnClose = null; this.hideModal(); onPick(o.value); } })), onClose);
  }

  /** Clears the local watch history (and the cached home) so "مقترح لك" starts over with fresh videos. */
  clearHistory() {
    const note = yt.loggedIn ? '\n(سجل حساب يوتيوب نفسه لا يُمسح من هنا)' : '';
    this.confirm('مسح سجل المشاهدة؟ ستتجدد مقترحات الرئيسية.' + note, () => {
      history.clear();
      try { localStorage.removeItem('ytlg.homeCache'); } catch { /* storage unavailable */ }
      toast('تم مسح السجل — ستظهر مقترحات جديدة في الرئيسية', 3500);
      this.reload();
    });
  }

  confirm(text, yes) {
    this.showModal(text, '', [
      { label: 'نعم', pick: () => { this.hideModal(); yes(); } },
      { label: 'لا', pick: () => this.hideModal() }
    ]);
  }
}
