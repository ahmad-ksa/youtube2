// Persistent settings, local watch history and resume positions (localStorage, guarded).

const DEFAULTS = {
  hl: 'ar',
  gl: 'SA',
  quality: 1080, // start quality: 'max' | 4320 | 2160 | 1440 | 1080 | 720 | 480
  codec: 'auto', // 'auto' | 'av01' | 'vp9' | 'avc1'
  hdrOn: false, // HDR off by default: webOS may reject HDR streams when the HDR config lookup is unavailable
  speed: 1,
  shorts: false,
  autoplay: true,
  captions: '', // preferred caption language ('' = off)
  translate: 'ar', // auto-translate captions to this language ('' = off)
  sb: true,
  sbCats: ['sponsor', 'selfpromo', 'interaction', 'intro', 'outro', 'music_offtopic'],
  buffer: 60,
  dearrow: false,
  dearrowThumbs: false,
  seekStep: 10,
  fps: 'max',
  audioFmt: 'best'
};

function read(key, fallback) {
  try {
    const v = localStorage.getItem('ytlg.' + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}

function write(key, value) {
  try { localStorage.setItem('ytlg.' + key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

class Settings {
  data = { ...DEFAULTS, ...read('settings', {}) };
  get(k) { return this.data[k]; }
  set(k, v) { this.data[k] = v; write('settings', this.data); }
}

export const settings = new Settings();
// one-time: start quality defaults to 1080p (requested)
if (!settings.get('preset1080')) { settings.set('quality', 1080); settings.set('fps', 'max'); settings.set('preset1080', true); }

export const history = {
  list() { return read('history', []); },
  add(item) {
    const list = this.list().filter((i) => i.id !== item.id);
    list.unshift({ type: 'video', id: item.id, title: item.title, sub: item.sub || '', channelId: item.channelId || '', meta: '', thumb: item.thumb || `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`, duration: item.duration || '', at: Date.now() });
    write('history', list.slice(0, 200));
  },
  clear() { write('history', []); },
  /** channels the user watched (most recent first): [{channelId, name}] */
  channels() {
    const seen = new Set(); const out = [];
    for (const i of this.list()) {
      if (!i.channelId || seen.has(i.channelId)) continue;
      seen.add(i.channelId); out.push({ channelId: i.channelId, name: i.sub || '' });
    }
    return out;
  }
};

/** Favourite channels (heart button): [{channelId, name}] */
export const favorites = {
  list() { return read('favorites', []); },
  has(id) { return !!id && this.list().some((c) => c.channelId === id); },
  toggle(id, name) {
    if (!id) return false;
    const l = this.list();
    const on = l.some((c) => c.channelId === id);
    write('favorites', on ? l.filter((c) => c.channelId !== id) : [{ channelId: id, name: name || '' }, ...l]);
    return !on;
  }
};

export const resume = {
  get(id) { return read('pos', {})[id] || 0; },
  set(id, t, dur) {
    const all = read('pos', {});
    if (!dur || t < 15 || t > dur - 20) delete all[id]; else all[id] = Math.floor(t);
    const keys = Object.keys(all);
    if (keys.length > 300) delete all[keys[0]];
    write('pos', all);
  }
};

export const searches = {
  list() { return read('searches', []); },
  add(q) { write('searches', [q, ...this.list().filter((x) => x !== q)].slice(0, 12)); },
  clear() { write('searches', []); }
};

/** Start-quality presets (like SmartTube "video presets"): apply to every video when it starts. */
export const PRESETS = [
  ['max', 'أعلى جودة متاحة'],
  ...[[4320, 60], [4320, 30], [2160, 60], [2160, 30], [1440, 60], [1440, 30], [1080, 60], [1080, 30], [720, 60], [720, 30], [480, 30], [360, 30]]
    .map(([h, f]) => [`${h}p${f}`, `${h}p • ${f}fps`])
];

export function presetValue() {
  let q = settings.get('quality');
  if (q === 'auto') { settings.set('quality', 'max'); q = 'max'; }
  if (q === 'auto' || q === 'max') return q;
  return `${q}p${settings.get('fps') === 'max' ? 60 : settings.get('fps')}`;
}

export function presetLabel() {
  return PRESETS.find((p) => p[0] === presetValue())?.[1] || presetValue();
}

export function setPreset(v) {
  if (v === 'auto' || v === 'max') { settings.set('quality', v); settings.set('fps', 'max'); return; }
  const m = String(v).match(/^(\d+)p(\d+)$/);
  if (m) { settings.set('quality', Number(m[1])); settings.set('fps', Number(m[2])); }
}
