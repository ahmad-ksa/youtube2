// DeArrow (https://dearrow.ajay.app): community titles/thumbnails instead of clickbait. Optional.
import { settings } from './store.js';

const cache = new Map();
const queue = [];
let active = 0;

function pump() {
  while (active < 4 && queue.length) {
    const { id, resolve } = queue.shift();
    active++;
    fetch(`https://sponsor.ajay.app/api/branding?videoID=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((d) => {
        const title = d?.titles?.find((t) => !t.original && (t.locked || t.votes >= 0))?.title?.replace(/(^|\s)>(\S)/g, '$1$2') || null;
        const thumb = d?.thumbnails?.find((t) => !t.original && t.timestamp != null && (t.locked || t.votes >= 0));
        const res = { title, thumb: thumb ? `https://dearrow-thumb.ajay.app/api/v1/getThumbnail?videoID=${id}&time=${thumb.timestamp}` : null };
        cache.set(id, res);
        resolve(res);
      })
      .finally(() => { active--; pump(); });
  }
}

function branding(id) {
  if (cache.has(id)) return Promise.resolve(cache.get(id));
  return new Promise((resolve) => { queue.push({ id, resolve }); pump(); });
}

const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    observer.unobserve(e.target);
    const card = e.target;
    branding(card.dataset.vid).then((b) => {
      if (b.title) card.querySelector('.title').textContent = b.title;
      if (b.thumb && settings.get('dearrowThumbs')) {
        const img = card.querySelector('img');
        const pre = new Image();
        pre.onload = () => { img.src = b.thumb; };
        pre.src = b.thumb;
      }
    });
  }
}, { rootMargin: '400px' }) : null;

export const dearrow = {
  watch(card, videoId) {
    if (!settings.get('dearrow') || !observer || !videoId) return;
    card.dataset.vid = videoId;
    observer.observe(card);
  },
  async title(videoId) {
    if (!settings.get('dearrow')) return null;
    return (await branding(videoId)).title;
  }
};
