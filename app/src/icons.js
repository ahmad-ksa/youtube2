// Inline SVG icons (TV fonts lack many symbol glyphs).
const svg = (d, vb = '0 0 24 24') => `<svg class="ic-svg" viewBox="${vb}" width="1em" height="1em" fill="currentColor" aria-hidden="true">${d}</svg>`;
export const ICON = {
  play: svg('<path d="M8 5v14l11-7z"/>'),
  pause: svg('<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>'),
  rew: svg('<path d="M11 18V6l-8.5 6 8.5 6zm.5-6 8.5 6V6l-8.5 6z"/>'),
  ffw: svg('<path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z"/>'),
  next: svg('<path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/>'),
  mic: '<svg class="ic-svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M7.5 21h9"/></svg>',
  search: svg('<path d="M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16a6.47 6.47 0 0 0 4.23-1.57l.27.28v.79l5 5L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 1 1 14 9.5 4.5 4.5 0 0 1 9.5 14z"/>'),
  prev: svg('<path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>'),
  heart: '<svg class="ic-svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.6 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
  heartOn: '<svg class="ic-svg" viewBox="0 0 24 24" width="1em" height="1em" fill="#ff0033" stroke="#ff0033" stroke-width="2" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.3-9.2C1.4 8 3.6 4.5 7 4.5c2 0 3.6 1.1 5 3 1.4-1.9 3-3 5-3 3.4 0 5.6 3.5 4.3 6.8-1.8 4.6-9.3 9.2-9.3 9.2z"/></svg>',
  list: svg('<path d="M3 6h13v2H3zm0 5h13v2H3zm0 5h9v2H3zm14-1v-6l5 3z"/>')
};
