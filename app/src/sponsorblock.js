// SponsorBlock segments (https://sponsor.ajay.app, CORS-enabled public API).
import { settings } from './store.js';

const LABELS = {
  sponsor: 'إعلان راعٍ', selfpromo: 'ترويج ذاتي', interaction: 'تذكير بالاشتراك', intro: 'مقدمة',
  outro: 'خاتمة', preview: 'ملخص/إعادة', music_offtopic: 'جزء غير موسيقي', filler: 'حشو'
};

export const sponsorblock = {
  label: (c) => LABELS[c] || c,
  async get(videoId) {
    const cats = settings.get('sbCats') || [];
    if (!cats.length) return [];
    try {
      const url = `https://sponsor.ajay.app/api/skipSegments?videoID=${encodeURIComponent(videoId)}&categories=${encodeURIComponent(JSON.stringify(cats))}`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const list = await r.json();
      return list.filter((s) => s.actionType === 'skip' || !s.actionType)
        .map((s) => ({ start: s.segment[0], end: s.segment[1], category: s.category }));
    } catch { return []; }
  },
  LABELS
};
