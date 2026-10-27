// Explore, Trending and date-sorted topic pages. Built from YouTube search (WEB client, which always carries
// the upload date) so every list can be sorted newest -> oldest, with nothing taken from the viewer's own
// favourites, watch history or suggestions.
import { yt, ageOf } from './yt.js';
import { extract } from './extract.js';
import { settings, history, favorites } from './store.js';

const DAY = 86400;

// search "sp" params (protobuf): sort 2 = upload date, 3 = view count; upload filter 2 = today, 3 = week, 4 = month; type 1 = video
const SP = {
  relevance: { today: 'EgQIAhAB', week: 'EgQIAxAB', month: 'EgQIBBAB' },
  views: { today: 'CAMSBAgCEAE=', week: 'CAMSBAgDEAE=', month: 'CAMSBAgEEAE=' },
  newest: { any: 'CAISAhAB' }
};

// Successive age windows: each batch only keeps videos older than the previous one, so appending batches
// keeps the whole list sorted newest -> oldest.
const WINDOWS = [
  { sp: 'today', min: 0, max: DAY },
  { sp: 'week', min: DAY, max: 7 * DAY },
  { sp: 'month', min: 7 * DAY, max: 31 * DAY }
];

// Wide mix of subjects and languages (Arabic, English, French, Turkish, Spanish, Hindi/Urdu, Indonesian, Japanese, Korean)
const EXPLORE_QUERIES = [
  'وثائقي', 'طبخ', 'وصفات سهلة', 'سفر', 'رحلة', 'تقنية', 'مراجعة جوال', 'علوم', 'فضاء', 'تاريخ', 'قصة حقيقية',
  'كوميديا', 'مقالب', 'سيارات', 'تعليم', 'تطوير الذات', 'بودكاست', 'تحدي', 'حيوانات', 'طبيعة', 'صناعة', 'فن',
  'تصميم', 'رسم', 'خط عربي', 'شعر', 'أنمي', 'ألعاب فيديو', 'كرة القدم', 'رياضة', 'لياقة', 'صحة', 'اقتصاد',
  'برمجة', 'ذكاء اصطناعي', 'تجربة', 'ألغاز', 'جريمة', 'مطاعم', 'أكل شوارع', 'زراعة', 'بناء', 'تصليح',
  'documentary', 'cooking', 'street food', 'travel vlog', 'tech review', 'science experiment', 'space', 'history',
  'comedy sketch', 'cars review', 'DIY', 'woodworking', 'restoration', 'nature', 'wildlife', 'music live session',
  'interview', 'podcast', 'challenge', 'gaming', 'speedrun', 'animation', 'short film', 'magic trick', 'drawing',
  'fitness', 'architecture', 'engineering', 'chess', 'football skills', 'basketball', 'fishing', 'camping',
  'cuisine française', 'voyage', 'yemek tarifi', 'gezi vlog', 'receta', 'viaje', 'खाना', 'यात्रा',
  'masak', 'jalan jalan', '料理', '旅行', '요리', '여행'
];

// Broad, high-traffic subjects in many languages for "most watched now"
const TREND_QUERIES = [
  'music video', 'official video', 'trailer', 'news', 'football', 'highlights', 'gaming', 'live', 'podcast',
  'comedy', 'challenge', 'review', 'vlog', 'reaction', 'interview', 'documentary', 'anime', 'tutorial',
  'فيديو كليب', 'أغنية', 'اخبار', 'عاجل', 'مباراة', 'ملخص', 'برنامج', 'مسلسل', 'بودكاست', 'تحدي', 'مقلب',
  'clip officiel', 'şarkı', 'canción', 'gana', 'lagu', 'MV', 'ニュース', '뮤직비디오'
];

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

async function search(query, sp) {
  try {
    const r = extract(await yt.raw('/search', { query, params: sp, client: 'WEB' }), { noShorts: true });
    return r.items.filter((i) => i.type === 'video' && !i.live && !i.short);
  } catch (e) { console.warn('[discover]', query, e?.message); return []; }
}

/** Channels and videos that belong to the viewer (excluded from Explore / Trending). */
function personal() {
  const ids = new Set(); const names = new Set(); const vids = new Set();
  for (const c of favorites.list()) { if (c.channelId) ids.add(c.channelId); if (c.name) names.add(c.name); }
  for (const c of history.channels()) { if (c.channelId) ids.add(c.channelId); if (c.name) names.add(c.name); }
  for (const v of history.list()) vids.add(v.id);
  return { ids, names, vids };
}

/**
 * A paged, date-sorted feed. next() returns the next window's videos (newest first) or null when done.
 * perChannel limits videos per channel across the whole feed (variety).
 */
function feed({ queries, perQuery, sort, perChannel, excludePersonal }) {
  let w = 0;
  const seenVid = new Set(); const perCh = new Map();
  const own = excludePersonal ? personal() : null;
  const pool = shuffle(queries.slice());
  let qi = 0;
  return async function next() {
    if (w >= WINDOWS.length) return null;
    const win = WINDOWS[w++];
    // a fresh slice of subjects for each window
    const take = []; for (let k = 0; k < perQuery; k++) take.push(pool[(qi++) % pool.length]);
    const lists = await Promise.all(take.map((q) => search(q, SP[sort][win.sp])));
    const out = [];
    for (const it of lists.flat()) {
      const age = ageOf(it.meta);
      if (age < win.min || age >= win.max) continue; // keeps batches in strict date order
      if (seenVid.has(it.id)) continue;
      const ch = it.channelId || it.sub;
      if (own && (own.vids.has(it.id) || own.ids.has(it.channelId) || own.names.has(it.sub))) continue;
      const n = perCh.get(ch) || 0;
      if (n >= perChannel) continue;
      perCh.set(ch, n + 1); seenVid.add(it.id);
      out.push({ ...it, age });
    }
    out.sort((a, b) => a.age - b.age);
    return out;
  };
}

/** Starts a feed and returns the first page plus a more() that yields the following (older) windows. */
async function paged(make) {
  const next = make();
  let items = await next();
  // skip empty leading windows (e.g. nothing parsed for "today")
  while (items && !items.length) items = await next();
  return {
    shelves: [{ title: '', items: items || [] }], items: items || [], continuation: null,
    more: async () => {
      let r = await next();
      while (r && !r.length) r = await next();
      return r ? { items: r, done: false } : { items: [], done: true };
    }
  };
}

/** استكشف: many different channels (Arabic and foreign, all subjects), none of the viewer's own, newest first. */
export function explore() {
  return paged(() => feed({ queries: EXPLORE_QUERIES, perQuery: 14, sort: 'relevance', perChannel: 1, excludePersonal: true }));
}

/** الترند: most-watched uploads worldwide (YouTube retired its Trending page in 2025), shown newest first. */
export function trending() {
  return paged(() => feed({ queries: TREND_QUERIES, perQuery: 18, sort: 'views', perChannel: 2, excludePersonal: false }));
}

/** News / Gaming: YouTube's topic page plus recent uploads, merged and sorted newest first. */
export async function topicByDate(key) {
  const extra = {
    news: ['أخبار', 'عاجل', 'نشرة الأخبار', 'news today', 'breaking news'],
    gaming: ['gameplay', 'ألعاب فيديو', 'gaming news', 'let\'s play', 'تختيم']
  }[key] || [];
  const [topic, ...found] = await Promise.all([
    yt.topic(key).catch((e) => { console.warn('[topic]', key, e?.message); return { items: [] }; }),
    ...extra.map((q) => search(q, SP.relevance.week))
  ]);
  const seen = new Set(); const out = [];
  for (const it of [...topic.items, ...found.flat()]) {
    if (it.type !== 'video' || it.live || (it.short && !settings.get('shorts')) || seen.has(it.id)) continue;
    seen.add(it.id); out.push({ ...it, age: ageOf(it.meta) });
  }
  out.sort((a, b) => a.age - b.age); // unknown dates (age 1e12) go last
  return { shelves: [{ title: '', items: out }], items: out, continuation: null };
}
