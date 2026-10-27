// Minimal spatial navigation for the LG remote (arrow keys + OK + Back).

export const KEY = {
  LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13, BACK: 461, ESC: 27, BACKSPACE: 8,
  PLAY: 415, PAUSE: 19, PLAYPAUSE: 10252, STOP: 413, FF: 417, RW: 412,
  RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406
};

const DIRS = { [KEY.LEFT]: 'left', [KEY.RIGHT]: 'right', [KEY.UP]: 'up', [KEY.DOWN]: 'down' };

export function dirOf(code) { return DIRS[code]; }

export function isBack(e) {
  return e.keyCode === KEY.BACK || e.keyCode === KEY.ESC || (e.keyCode === KEY.BACKSPACE && !isTyping());
}

export function isTyping() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA');
}

function visible(el) {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Finds the best focusable in `dir` from `from` inside `root`. */
export function findNext(root, from, dir) {
  const items = [...root.querySelectorAll('.f')].filter((el) => el !== from && !el.disabled && visible(el));
  if (!from) return items[0] || null;
  const a = from.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of items) {
    const b = el.getBoundingClientRect();
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let main, cross;
    switch (dir) {
      case 'left': main = a.left - b.right; cross = Math.abs(ay - by); if (bx >= ax - 1) continue; break;
      case 'right': main = b.left - a.right; cross = Math.abs(ay - by); if (bx <= ax + 1) continue; break;
      case 'up': main = a.top - b.bottom; cross = Math.abs(ax - bx); if (by >= ay - 1) continue; break;
      case 'down': main = b.top - a.bottom; cross = Math.abs(ax - bx); if (by <= ay + 1) continue; break;
      default: continue;
    }
    // prefer elements overlapping on the cross axis (same row / column)
    const overlap = dir === 'left' || dir === 'right'
      ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      : Math.min(a.right, b.right) - Math.max(a.left, b.left);
    // horizontal moves stay on the same row
    if ((dir === 'left' || dir === 'right') && overlap <= 0) continue;
    const score = Math.max(main, 0) + cross * (overlap > 0 ? 0.3 : 2.5) + (overlap > 0 ? 0 : 400);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
}

export function focus(el, opts = {}) {
  if (!el) return false;
  document.querySelectorAll('.focused').forEach((x) => x.classList.remove('focused'));
  el.classList.add('focused');
  if (el.tagName === 'INPUT') el.focus(); else {
    if (document.activeElement && document.activeElement !== el && document.activeElement.blur) document.activeElement.blur();
    el.focus?.({ preventScroll: true });
  }
  if (opts.scroll !== false) reveal(el);
  document.dispatchEvent(new CustomEvent('navfocus', { detail: el }));
  return true;
}

/** Scrolls horizontal rows and the vertical page so `el` is visible with some margin. */
export function reveal(el) {
  const row = el.closest('.row-items');
  if (row) {
    const r = row.getBoundingClientRect(), e = el.getBoundingClientRect();
    const pad = 60;
    if (e.left < r.left + pad) row.scrollLeft -= (r.left + pad - e.left);
    else if (e.right > r.right - pad) row.scrollLeft += (e.right - (r.right - pad));
  }
  const page = el.closest('.scroll-y');
  if (page) {
    const r = page.getBoundingClientRect(), e = el.getBoundingClientRect();
    const pad = 80;
    if (e.top < r.top + pad) page.scrollTop -= (r.top + pad - e.top);
    else if (e.bottom > r.bottom - pad) page.scrollTop += (e.bottom - (r.bottom - pad));
  }
}

export function current() { return document.querySelector('.focused'); }
