// الموسيقى العربية: from each Arab singer's channel, the newest song (video) and the newest album, all in ONE
// list sorted by release time, newest first. Singers = a fixed list of well-known names + channels found
// through this week's new Arabic songs. Exact times come from RSS (channel uploads and album playlists).
import { yt, itemAge, relTime } from './yt.js';
import { extract } from './extract.js';

const ARTISTS = [
  'محمد عبده', 'عبدالمجيد عبدالله', 'راشد الماجد', 'رابح صقر', 'ماجد المهندس', 'حسين الجسمي', 'أصالة', 'أحلام',
  'نوال الكويتية', 'بلقيس', 'داليا مبارك', 'عايض', 'فؤاد عبدالواحد', 'محمد عساف', 'عمرو دياب', 'تامر حسني',
  'محمد حماقي', 'شيرين عبد الوهاب', 'أنغام', 'ويجز', 'مروان موسى', 'نانسي عجرم', 'إليسا', 'وائل كفوري',
  'راغب علامة', 'ناصيف زيتون', 'كاظم الساهر', 'سعد لمجرد', 'حاتم عمور', 'الشاب خالد'
];
const DISCOVER = ['اغنية جديدة', 'فيديو كليب جديد', 'كليب حصري', 'اغاني خليجية جديدة', 'اغاني مصرية جديدة', 'اغاني عراقية جديدة', 'اغاني مغربية جديدة', 'اغاني لبنانية جديدة'];
const SP_CHANNEL = 'EgIQAg=='; const SP_PLAYLIST = 'EgIQAw=='; const SP_WEEK_VIDEO = 'EgQIAxAB';
const NOT_SONG = /شيل[ةه]|شيلات|نشيد|أنشودة|انشودة|إنشاد|اناشيد|أناشيد|قرآن|تلاوة|محاضرة|بودكاست/;
const ARABIC = /[؀-ۿ]/;
const DAY = 86400;

const norm = (s) => String(s || '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+|-|topic|توبيك/gi, '').toLowerCase();

/** runs async jobs with a small concurrency limit (the TV and YouTube both prefer fewer parallel requests) */
async function pool(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

async function search(query, sp) {
  return extract(await yt.raw('/search', { query, params: sp, client: 'WEB' }), { noShorts: true }).items;
}

// singer name -> channel id, kept on the TV for 30 days
function idCache() { try { return JSON.parse(localStorage.getItem('ytlg.artistIds') || '{}'); } catch { return {}; } }
function saveIds(c) { try { localStorage.setItem('ytlg.artistIds', JSON.stringify(c)); } catch { /* storage unavailable */ } }

async function resolveArtist(name, cache) {
  const hit = cache[name];
  if (hit && Date.now() - hit.at < 30 * DAY * 1000) return hit.id ? { channelId: hit.id, name } : null;
  const want = norm(name);
  const ch = (await search(name, SP_CHANNEL)).find((c) => c.type === 'channel' && norm(c.title).includes(want));
  cache[name] = { id: ch?.id || '', at: Date.now() };
  return ch ? { channelId: ch.id, name } : null;
}

/** Channels behind this week's new Arabic songs (labels and singers). */
async function discovered() {
  const lists = await pool(DISCOVER, 4, (q) => search(q, SP_WEEK_VIDEO));
  const out = new Map();
  for (const it of lists.flat().filter(Boolean)) {
    if (it.type !== 'video' || !it.channelId || !ARABIC.test(it.title) || NOT_SONG.test(`${it.title} ${it.sub}`)) continue;
    if (!out.has(it.channelId)) out.set(it.channelId, { channelId: it.channelId, name: it.sub });
    if (out.size >= 25) break;
  }
  return [...out.values()];
}

/** Newest song of a channel (exact time from its uploads RSS). */
async function newestSong(c) {
  const vids = await yt.rss(c.channelId);
  const v = vids.find((x) => !NOT_SONG.test(x.title));
  if (!v) return null;
  const age = itemAge(v);
  return age > 120 * DAY ? null : { ...v, sub: v.sub || c.name, age, meta: relTime(age) };
}

/**
 * Newest album of a singer: official album playlists (OLAK…) from search, each checked through its own RSS:
 * owner must be the singer ("Singer - Topic"), 3+ tracks (singles are not albums), date = newest track.
 */
async function newestAlbum(c) {
  const cands = (await search(`${c.name} ألبوم`, SP_PLAYLIST))
    .filter((p) => p.type === 'playlist' && /^OLAK5uy_/.test(p.id)).slice(0, 4);
  const want = norm(c.name);
  let best = null;
  for (const p of cands) {
    let tracks;
    try { tracks = await yt.rssPlaylist(p.id); } catch { continue; }
    if (tracks.entries.length < 3 || !norm(tracks.owner).includes(want)) continue;
    const at = Math.max(...tracks.entries.map((t) => t.publishedAt));
    if (!best || at > best.publishedAt) {
      best = { type: 'playlist', id: p.id, title: p.title, sub: c.name, publishedAt: at, videoId: tracks.entries[0].id,
        thumb: p.thumb || `https://i.ytimg.com/vi/${tracks.entries[0].id}/hqdefault.jpg`, tracks: tracks.entries.length };
    }
  }
  if (!best) return null;
  const age = itemAge(best);
  const n = best.tracks; const songs = n <= 10 ? `${n} أغانٍ` : `${n} أغنية`;
  return { ...best, age, meta: `ألبوم • ${songs} • ${relTime(age)}` };
}

let memo = null; // { at, data } — 30 min, so going back and forth is instant

/** الموسيقى العربية page data. */
export async function arabicMusic({ fresh } = {}) {
  if (!fresh && memo && Date.now() - memo.at < 30 * 60e3) return memo.data;
  const cache = idCache();
  const [fixed, found] = await Promise.all([
    pool(ARTISTS, 5, (n) => resolveArtist(n, cache)).then((r) => { saveIds(cache); return r.filter(Boolean); }),
    discovered().catch(() => [])
  ]);
  const channels = new Map();
  for (const c of [...fixed, ...found]) if (!channels.has(c.channelId)) channels.set(c.channelId, c);
  const list = [...channels.values()];
  const [songs, albums] = await Promise.all([
    pool(list, 6, newestSong),
    pool(fixed, 4, newestAlbum) // albums: for named singers (label channels have no albums of their own)
  ]);
  const out = [...songs, ...albums].filter(Boolean);
  out.sort((a, b) => a.age - b.age);
  const data = { shelves: [{ title: '', items: out }], items: out, continuation: null };
  memo = { at: Date.now(), data };
  return data;
}
