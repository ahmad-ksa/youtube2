// Explore (world / Arab), Trending (world / Arab) and date-sorted News / Gaming.
// Built from YouTube search (WEB client, which always carries the upload date) so every list is sorted
// newest -> oldest across all channels. Nothing is taken from the viewer's favourites, history or suggestions.
// Searches run in separate guest sessions with YouTube's Restricted Mode on (filters mature content),
// so they are not personalised by the signed-in account either.
import { Innertube } from 'youtubei.js/web';
import { yt, ageOf, itemAge, boundFetch, searchGate, botPaused } from './yt.js';
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
// songs only, many languages and styles (most-watched music worldwide)
const MUSIC_TREND = [
  'official music video', 'music video', 'official audio', 'lyric video', 'new song', 'MV', 'kpop MV', 'pop song',
  'hip hop', 'rap song', 'reggaeton', 'afrobeats', 'rock song', 'EDM', 'country song', 'video oficial',
  'clip officiel', 'клип', 'фит', 'Musikvideo', 'فيديو كليب', 'أغنية', '뮤직비디오', 'live performance'
];
const ARAB_TREND = [
  'فيديو كليب', 'أغنية', 'اخبار', 'عاجل', 'مباراة', 'ملخص', 'أهداف', 'برنامج', 'مسلسل', 'حلقة', 'بودكاست',
  'تحدي', 'مقلب', 'فلوق', 'ردة فعل', 'مقابلة', 'كوميدي', 'شيلة', 'مهرجان', 'السعودية', 'مصر', 'المغرب'
];

// Saudi Arabia: cities, football, food, culture, desert life, entertainment
const SAUDI_EXPLORE = [
  'الرياض', 'جدة', 'الدمام', 'الخبر', 'مكة', 'المدينة المنورة', 'أبها', 'الطائف', 'القصيم', 'حائل', 'تبوك', 'العلا',
  'نيوم', 'موسم الرياض', 'فلوق سعودي', 'طبخ سعودي', 'كبسة', 'مندي', 'قهوة سعودية', 'كشتة', 'رحلة برية', 'تطعيس',
  'مقناص', 'هجن', 'خيل', 'سيارات سعودية', 'سوالف', 'قصة سعودية', 'بودكاست سعودي', 'مسلسل سعودي', 'كوميديا سعودية',
  'دوري روشن', 'تقنية سعودي', 'مطاعم الرياض', 'تراث سعودي', 'العرضة السعودية', 'تحدي سعودي', 'مخيم'
];
const SAUDI_TREND = [
  'السعودية', 'سعودي', 'الرياض', 'جدة', 'دوري روشن', 'الهلال', 'النصر', 'الاتحاد', 'الأهلي', 'شيلة', 'موسم الرياض',
  'مسلسل سعودي', 'بودكاست سعودي', 'سنابات', 'فلوق سعودي', 'ملخص مباراة', 'أخبار السعودية', 'عاجل السعودية', 'برنامج سعودي'
];
// Gulf: the six GCC countries
const GULF_EXPLORE = [
  'الرياض', 'جدة', 'فلوق سعودي', 'كبسة', 'كشتة', 'الكويت', 'فلوق كويتي', 'مطاعم الكويت', 'الدوحة', 'قطر', 'دبي',
  'أبوظبي', 'الشارقة', 'فلوق إماراتي', 'البحرين', 'المنامة', 'مسقط', 'صلالة', 'سلطنة عمان سياحة', 'طبخ خليجي', 'مجبوس',
  'مسلسل خليجي', 'غوص', 'صيد سمك', 'برية', 'تراث خليجي', 'سيارات', 'سوالف خليجية', 'بودكاست خليجي', 'مخيم', 'هجن'
];
const GULF_TREND = [
  'السعودية', 'الكويت', 'قطر', 'الإمارات', 'دبي', 'البحرين', 'سلطنة عمان', 'خليجي', 'مسلسل خليجي', 'شيلة', 'دوري روشن',
  'دوري نجوم قطر', 'الدوري الإماراتي', 'الدوري الكويتي', 'أخبار الخليج', 'عاجل', 'ملخص مباراة', 'فلوق', 'بودكاست خليجي', 'كليب خليجي'
];
const GULF_SESSIONS = ['gl:SA', 'gl:AE', 'gl:KW', 'gl:QA', 'gl:BH', 'gl:OM'];

// whole-word place / nationality markers (with or without "ال", and nisba endings: سعودي، سعودية، سعوديين…)
const W = (words) => new RegExp(`(?:^|[\\s\\p{P}\\p{S}])(?:ال)?(?:${words})(?:ي|ية|يه|يين|يون)?(?=$|[\\s\\p{P}\\p{S}])`, 'u');
const SAUDI_MARK = W('سعود|رياض|جدة|جده|دمام|خبر|مكة|مكه|المدينة المنورة|أبها|ابها|طائف|قصيم|حائل|تبوك|علا|نيوم|هلال|نصر|اتحاد|أهلي|اهلي|روشن|نجد|حجاز');
// bare "عمان" is left out on purpose: it is also Amman (Jordan); Omani videos say سلطنة عمان / عماني / مسقط / صلالة
const GULF_OTHER = W('كويت|قطر|إمارات|امارات|دبي|أبوظبي|ابوظبي|شارقة|شارقه|بحرين|منامة|سلطنة عمان|عماني|مسقط|صلالة|دوحة|دوحه');
const NON_GULF = W('مصر|قاهرة|قاهره|إسكندرية|اسكندرية|مغرب|جزائر|تونس|ليبيا|ليب|عراق|بغداد|سوريا|سوري|شام|دمشق|حلب|لبنان|بيروت|أردن|اردن|فلسطين|غزة|غزه|سودان|يمن|صنعاء|موريتاني|صومال');

// ---------------------------------------------------------------- filters

const ARABIC = /[؀-ۿ]/;
// letters used by Urdu / Persian but not by Arabic (keeps Pakistani / Iranian titles out of the Arab lists)
const URDU_PERSIAN = /[ٹڈڑںھہےیکگپچژ]/;
// Indic scripts, Tagalog/Filipino and South-Asian markers (for "Explore the World")
const SOUTH_ASIA_SCRIPT = /[ऀ-෿]/; // Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam, Sinhala
const SOUTH_ASIA_WORDS = /\b(hindi|bollywood|tamil|telugu|punjabi|bhojpuri|marathi|kannada|malayalam|bangla|bengali|urdu|desi|india|indian|pakistan|pakistani|lahore|karachi|mumbai|delhi|pinoy|filipino|filipina|tagalog|philippines|manila|ofw|kapuso|kapamilya)\b/i;
// sexual / adult content (titles or channel names), several languages; Restricted Mode is the main filter
const ADULT = /\b(sex|sexy|porn|nsfw|nude|naked|erotic|onlyfans|18\+|xxx|hot girl|bikini try|lingerie|strip|секс|эрот|порно|섹시|노출|야한)\b|سكس|إباح|اباح|عاري|عارية|جنس|مثير(?:ة)?\s|بدون ملابس/i;

export const isAdult = (it) => ADULT.test(`${it.title} ${it.sub}`);
const RULES = {
  world: (it) => !isAdult(it) && !ARABIC.test(it.title) && !SOUTH_ASIA_SCRIPT.test(`${it.title} ${it.sub}`) && !SOUTH_ASIA_WORDS.test(`${it.title} ${it.sub}`),
  arab: (it) => !isAdult(it) && ARABIC.test(it.title) && !URDU_PERSIAN.test(it.title) && !SOUTH_ASIA_SCRIPT.test(it.title),
  worldTrend: (it) => !isAdult(it),
  // Saudi lists: Arabic; kept when it names Saudi places / clubs, dropped when it points to another country
  saudi: (it) => {
    if (!RULES.arab(it)) return false;
    const t = `${it.title} ${it.sub}`;
    return SAUDI_MARK.test(t) || (!GULF_OTHER.test(t) && !NON_GULF.test(t));
  },
  // Gulf lists: Arabic; kept when it names a Gulf country / place, dropped when it points outside the Gulf
  gulf: (it) => {
    if (!RULES.arab(it)) return false;
    const t = `${it.title} ${it.sub}`;
    return SAUDI_MARK.test(t) || GULF_OTHER.test(t) || !NON_GULF.test(t);
  }
};

// ---------------------------------------------------------------- sessions

const sessions = {};
/** Guest session with Restricted Mode, separate from the signed-in one. Falls back to the main session. */
function session(kind) {
  if (!sessions[kind]) {
    const opt = kind === 'world' ? { lang: 'en', location: 'US' }
      : kind.startsWith('gl:') ? { lang: 'ar', location: kind.slice(3) } // a Gulf country's own YouTube
      : { lang: 'ar', location: settings.get('gl') || 'SA' };
    sessions[kind] = Innertube.create({ ...opt, enable_safety_mode: true, retrieve_player: false, generate_session_locally: false, fetch: boundFetch })
      .catch((e) => { console.warn('[discover] session', kind, e?.message); sessions[kind] = null; return null; });
  }
  return sessions[kind];
}

async function search(kind, query, sp) {
  if (botPaused()) return [];
  try {
    const tube = await session(kind);
    const data = await searchGate(async () => (tube
      ? (await tube.actions.execute('/search', { query, params: sp, client: 'WEB', parse: false })).data
      : await yt.raw('/search', { query, params: sp, client: 'WEB' })));
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
    const kinds = [].concat(kind);
    const lists = await Promise.all(take.map((q, k) => search(kinds[k % kinds.length], q, SP[sort][win.sp])));
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

const listCache = new Map(); // query pool -> { at, data }: reopening a list within 45 min sends no new searches

async function paged(opts, fresh) {
  const hit = listCache.get(opts.queries);
  if (!fresh && hit && Date.now() - hit.at < 45 * 60e3) return hit.data;
  if (botPaused()) throw new Error('متوقف مؤقتًا لأن يوتيوب طلب التحقق من أنك لست روبوتاً — حاول بعد نصف ساعة');
  const data = await pagedFresh(opts);
  if (data.items.length) listCache.set(opts.queries, { at: Date.now(), data });
  return data;
}

async function pagedFresh(opts) {
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
export const exploreWorld = (fresh) => paged({ kind: 'world', queries: WORLD_EXPLORE, perQuery: 6, sort: 'relevance', perChannel: 1, rule: RULES.world, excludePersonal: true }, fresh);
/** استكشف العرب: every Arab country, Arabic content only. */
export const exploreArab = (fresh) => paged({ kind: 'arab', queries: ARAB_EXPLORE, perQuery: 6, sort: 'relevance', perChannel: 1, rule: RULES.arab, excludePersonal: true }, fresh);
/** تريند العالم: most-watched uploads worldwide (YouTube retired its Trending page in 2025). */
export const trendWorld = (fresh) => paged({ kind: 'world', queries: WORLD_TREND, perQuery: 8, sort: 'views', perChannel: 2, rule: RULES.worldTrend }, fresh);
/** تريند الأغاني العالمي: most-watched songs worldwide right now. */
export const trendMusic = (fresh) => paged({ kind: 'world', queries: MUSIC_TREND, perQuery: 8, sort: 'views', perChannel: 2, rule: RULES.worldTrend }, fresh);
/** استكشف السعودية / الترند السعودي: Saudi YouTube (region SA), Saudi subjects, other countries filtered out. */
export const exploreSaudi = (fresh) => paged({ kind: 'gl:SA', queries: SAUDI_EXPLORE, perQuery: 6, sort: 'relevance', perChannel: 1, rule: RULES.saudi, excludePersonal: true }, fresh);
export const trendSaudi = (fresh) => paged({ kind: 'gl:SA', queries: SAUDI_TREND, perQuery: 8, sort: 'views', perChannel: 2, rule: RULES.saudi }, fresh);
/** استكشف الخليج / ترند الخليج: the six GCC countries, each search run in one of their own YouTube regions. */
export const exploreGulf = (fresh) => paged({ kind: GULF_SESSIONS, queries: GULF_EXPLORE, perQuery: 6, sort: 'relevance', perChannel: 1, rule: RULES.gulf, excludePersonal: true }, fresh);
export const trendGulf = (fresh) => paged({ kind: GULF_SESSIONS, queries: GULF_TREND, perQuery: 8, sort: 'views', perChannel: 2, rule: RULES.gulf }, fresh);
/** الترند العربي: most-watched Arabic uploads. */
export const trendArab = (fresh) => paged({ kind: 'arab', queries: ARAB_TREND, perQuery: 8, sort: 'views', perChannel: 2, rule: RULES.arab }, fresh);

/** News / Gaming: YouTube's topic page plus this week's uploads, ONE list sorted by date, newest first. */
export async function topicByDate(key) {
  const extra = {
    news: ['أخبار', 'عاجل', 'news today'],
    gaming: ['gameplay', 'ألعاب فيديو', 'تختيم']
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
