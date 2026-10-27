// Explore (world / Arab), Trending (world / Arab) and date-sorted News / Gaming.
// Built from YouTube search (WEB client, which always carries the upload date) so every list is sorted
// newest -> oldest across all channels. Nothing is taken from the viewer's favourites, history or suggestions.
// Searches run in separate guest sessions with YouTube's Restricted Mode on (filters mature content),
// so they are not personalised by the signed-in account either.
import { Innertube } from 'youtubei.js/web';
import { yt, ageOf, itemAge, boundFetch } from './yt.js';
import { extract } from './extract.js';
import { settings, history, favorites } from './store.js';

const DAY = 86400;

// search "sp" params (protobuf): sort 3 = view count; upload filter 2 = today, 3 = week, 4 = month; type 1 = video
const SP = {
  relevance: { today: 'EgQIAhAB', week: 'EgQIAxAB', month: 'EgQIBBAB' },
  views: { today: 'CAMSBAgCEAE=', week: 'CAMSBAgDEAE=', month: 'CAMSBAgEEAE=' }
};

// Successive age windows: each batch only keeps videos older than the previous one, so appending batches
// keeps the whole list sorted newest -> oldest.
const WINDOWS = [
  { sp: 'today', min: 0, max: DAY },
  { sp: 'week', min: DAY, max: 7 * DAY },
  { sp: 'month', min: 7 * DAY, max: 31 * DAY }
];

// ---------------------------------------------------------------- query pools

// Europe, Americas, Russia, Korea (English, French, German, Spanish, Italian, Portuguese, Dutch, Polish,
// Swedish, Russian, Korean)
const WORLD_EXPLORE = [
  'documentary', 'cooking', 'street food', 'travel vlog', 'tech review', 'science experiment', 'space', 'history',
  'comedy sketch', 'car review', 'DIY', 'woodworking', 'restoration', 'nature', 'wildlife', 'live session',
  'interview', 'podcast', 'challenge', 'gaming', 'speedrun', 'animation', 'short film', 'magic trick', 'drawing',
  'workout', 'architecture', 'engineering', 'chess', 'football', 'NBA', 'NFL', 'fishing', 'camping', 'van life',
  'recette', 'voyage', 'documentaire', 'humour', 'Rezept', 'Reise', 'Doku', 'receta', 'viaje', 'documental',
  'ricetta', 'viaggio', 'receita', 'viagem', 'reis', 'podróż', 'resa',
  'рецепт', 'путешествие', 'документальный', 'обзор', 'юмор', 'наука',
  '요리', '여행', '브이로그', '리뷰', '예능', '과학'
];
// Every Arab country, plus subjects (Arabic only)
const ARAB_EXPLORE = [
  'السعودية', 'مصر', 'الإمارات', 'الكويت', 'قطر', 'البحرين', 'عمان', 'اليمن', 'العراق', 'سوريا', 'لبنان', 'الأردن',
  'فلسطين', 'المغرب', 'الجزائر', 'تونس', 'ليبيا', 'السودان', 'موريتانيا', 'الصومال', 'جيبوتي', 'جزر القمر',
  'وثائقي', 'طبخ', 'أكلات شعبية', 'سفر', 'رحلة', 'تقنية', 'مراجعة', 'علوم', 'تاريخ', 'قصة', 'كوميديا', 'مقالب',
  'سيارات', 'تعليم', 'بودكاست', 'تحدي', 'حيوانات', 'طبيعة', 'صحراء', 'تراث', 'فن', 'خط عربي', 'شعر', 'إنشاد',
  'كرة القدم', 'رياضة', 'لياقة', 'اقتصاد', 'برمجة', 'ألعاب', 'مطاعم', 'زراعة', 'بناء', 'رمضان', 'سوالف', 'فلوق'
];
// Broad, high-traffic subjects for "most watched now"
const WORLD_TREND = [
  'music video', 'official video', 'trailer', 'news', 'football', 'highlights', 'gaming', 'podcast', 'comedy',
  'challenge', 'review', 'vlog', 'reaction', 'interview', 'documentary', 'anime', 'clip officiel', 'canción',
  'клип', 'новости', '뮤직비디오', 'MV'
];
const ARAB_TREND = [
  'فيديو كليب', 'أغنية', 'اخبار', 'عاجل', 'مباراة', 'ملخص', 'أهداف', 'برنامج', 'مسلسل', 'حلقة', 'بودكاست',
  'تحدي', 'مقلب', 'فلوق', 'ردة فعل', 'مقابلة', 'كوميدي', 'شيلة', 'مهرجان', 'السعودية', 'مصر', 'المغرب'
];

// ---------------------------------------------------------------- filters

const ARABIC = /[؀-ۿ]/;
// letters used by Urdu / Persian but not by Arabic (keeps Pakistani / Iranian titles out of the Arab lists)
const URDU_PERSIAN = /[ٹڈڑںھہےیکگپچژ]/;
// Indic scripts, Tagalog/Filipino and South-Asian markers (for "Explore the World")
const SOUTH_ASIA_SCRIPT = /[ऀ-෿]/; // Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala
const SOUTH_ASIA_WORDS = /\b(hindi|bollywood|tamil|telugu|punjabi|bhojpuri|marathi|kannada|malayalam|bangla|bengali|urdu|desi|india|indian|pakistan|pakistani|lahore|karachi|mumbai|delhi|pinoy|filipino|filipina|tagalog|philippines|manila|ofw|kapuso|kapamilya)\b/i;
// sexual / adult content (titles or channel names), several languages; Restricted Mode is the main filter
const ADULT = /\b(sex|sexy|porn|nsfw|nude|naked|erotic|onlyfans|18\+|xxx|hot girl|bikini try|lingerie|strip|секс|эрот|порно|섹시|노출|야한)\b|سكس|إباح|اباح|عاري|عارية|جنس|مثير(?:ة)?\s|بدون ملابس/i;

const isAdult = (it) => ADULT.test(`${it.title} ${it.sub}`);
const RULES = {
  world: (it) => !isAdult(it) && !ARABIC.test(it.title) && !SOUTH_ASIA_SCRIPT.test(`${it.title} ${it.sub}`) && !SOUTH_ASIA_WORDS.test(`${it.title} ${it.sub}`),
  arab: (it) => !isAdult(it) && ARABIC.test(it.title) && !URDU_PERSIAN.test(it.title) && !SOUTH_ASIA_SCRIPT.test(it.title),
  worldTrend: (it) => !isAdult(it)
};

// ---------------------------------------------------------------- sessions

const sessions = {};
/** Guest session with Restricted Mode, separate from the signed-in one. Falls back to the main session. */
function session(kind) {
  if (!sessions[kind]) {
    const opt = kind === 'world' ? { lang: 'en', location: 'US' } : { lang: 'ar', location: settings.get('gl') || 'SA' };
    sessions[kind] = Innertube.create({ ...opt, enable_safety_mode: true, retrieve_player: false, generate_session_locally: false, fetch: boundFetch })
      .catch((e) => { console.warn('[discover] session', kind, e?.message); sessions[kind] = null; return null; });
  }
  return sessions[kind];
}

async function search(kind, query, sp) {
  try {
    const tube = await session(kind);
    const data = tube
      ? (await tube.actions.execute('/search', { query, params: sp, client: 'WEB', parse: false })).data
      : await yt.raw('/search', { query, params: sp, client: 'WEB' });
    return extract(data, { noShorts: true }).items.filter((i) => i.type === 'video' && !i.live && !i.short);
  } catch (e) { console.warn('[discover]', query, e?.message); return []; }
}

// ---------------------------------------------------------------- feeds

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

/** Channels and videos that belong to the viewer (left out of Explore). */
function personal() {
  const ids = new Set(); const names = new Set(); const vids = new Set();
  for (const c of favorites.list()) { if (c.channelId) ids.add(c.channelId); if (c.name) names.add(c.name); }
  for (const c of history.channels()) { if (c.channelId) ids.add(c.channelId); if (c.name) names.add(c.name); }
  for (const v of history.list()) vids.add(v.id);
  return { ids, names, vids };
}

/** A paged, date-sorted feed: next() returns the next (older) window's videos, newest first, or null. */
function feed({ kind, queries, perQuery, sort, perChannel, rule, excludePersonal }) {
  let w = 0; let qi = 0;
  const seenVid = new Set(); const perCh = new Map();
  const own = excludePersonal ? personal() : null;
  const pool = shuffle(queries.slice());
  return async function next() {
    if (w >= WINDOWS.length) return null;
    const win = WINDOWS[w++];
    const take = []; for (let k = 0; k < perQuery; k++) take.push(pool[(qi++) % pool.length]);
    const lists = await Promise.all(take.map((q) => search(kind, q, SP[sort][win.sp])));
    const out = [];
    for (const it of lists.flat()) {
      const age = itemAge(it);
      if (age < win.min || age >= win.max) continue; // keeps batches in strict date order
      if (seenVid.has(it.id) || !rule(it)) continue;
      if (own && (own.vids.has(it.id) || own.ids.has(it.channelId) || own.names.has(it.sub))) continue;
      const ch = it.channelId || it.sub; const n = perCh.get(ch) || 0;
      if (n >= perChannel) continue;
      perCh.set(ch, n + 1); seenVid.add(it.id);
      out.push({ ...it, age });
    }
    out.sort((a, b) => a.age - b.age);
    return out;
  };
}

async function paged(opts) {
  const next = feed(opts);
  let items = await next();
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

/** استكشف العالم: Europe, the Americas, Russia, Korea — no South Asia / Philippines, no adult content. */
export const exploreWorld = () => paged({ kind: 'world', queries: WORLD_EXPLORE, perQuery: 14, sort: 'relevance', perChannel: 1, rule: RULES.world, excludePersonal: true });
/** استكشف العرب: every Arab country, Arabic content only. */
export const exploreArab = () => paged({ kind: 'arab', queries: ARAB_EXPLORE, perQuery: 14, sort: 'relevance', perChannel: 1, rule: RULES.arab, excludePersonal: true });
/** تريند العالم: most-watched uploads worldwide (YouTube retired its Trending page in 2025). */
export const trendWorld = () => paged({ kind: 'world', queries: WORLD_TREND, perQuery: 18, sort: 'views', perChannel: 2, rule: RULES.worldTrend });
/** الترند العربي: most-watched Arabic uploads. */
export const trendArab = () => paged({ kind: 'arab', queries: ARAB_TREND, perQuery: 18, sort: 'views', perChannel: 2, rule: RULES.arab });

/** News / Gaming: YouTube's topic page plus this week's uploads, ONE list sorted by date, newest first. */
export async function topicByDate(key) {
  const extra = {
    news: ['أخبار', 'عاجل', 'نشرة الأخبار', 'آخر الأخبار', 'news today', 'breaking news'],
    gaming: ['gameplay', 'ألعاب فيديو', 'تختيم', 'gaming news', "let's play", 'بث ألعاب']
  }[key] || [];
  const [topic, ...found] = await Promise.all([
    yt.topic(key).catch((e) => { console.warn('[topic]', key, e?.message); return { items: [] }; }),
    ...extra.map((q) => search('arab', q, SP.relevance.week))
  ]);
  const seen = new Set(); const dated = []; const undated = [];
  for (const it of [...topic.items, ...found.flat()]) {
    if (it.type !== 'video' || it.live || (it.short && !settings.get('shorts')) || seen.has(it.id) || isAdult(it)) continue;
    seen.add(it.id);
    const age = itemAge(it);
    (age < 1e12 ? dated : undated).push({ ...it, age });
  }
  dated.sort((a, b) => a.age - b.age);
  // items YouTube gave without any date cannot be placed in time: shown after the dated ones
  const out = dated.concat(undated);
  return { shelves: [{ title: '', items: out }], items: out, continuation: null };
}

export { ageOf };
