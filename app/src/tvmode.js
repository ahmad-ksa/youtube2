// Official player mode: plays videos in YouTube's own TV app (https://www.youtube.com/tv), opened as the MAIN
// page exactly like webosbrew/youtube-webos (YouTube AdFree) does. YouTube's own code then does attestation,
// /player, streaming and sign-in, so there are no "not a bot" checks, reload loops or PoToken issues.
// Our user script runs on that page too and only: strips ads, skips SponsorBlock segments, picks "guest" on
// the who's-watching screen, remembers the position, and returns to our interface when the player is left.
// (An iframe was tried before and YouTube's TV app never started playback inside it.)
import { resume, settings, history } from './store.js';
import { sponsorblock } from './sponsorblock.js';

export const TV_URL = 'https://www.youtube.com/tv';
export const HOME_URL = 'https://www.youtube.com/robots.txt';

// ---------------------------------------------------------------- ads (same rule set as youtube-webos)
function stripAds(r) {
  if (!r || typeof r !== 'object') return r;
  if (r.adPlacements) delete r.adPlacements;
  if (Array.isArray(r.adSlots)) delete r.adSlots;
  if (r.playerAds) delete r.playerAds;
  const strip = (sl) => {
    if (!sl?.contents) return;
    sl.contents = sl.contents.filter((e) => !e.adSlotRenderer && !e.tvMastheadRenderer);
    for (const c of sl.contents) {
      const hl = c.shelfRenderer?.content?.horizontalListRenderer;
      if (hl?.items) hl.items = hl.items.filter((e) => !e.adSlotRenderer);
    }
  };
  strip(r.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content?.sectionListRenderer);
  strip(r.contents?.sectionListRenderer);
  if (Array.isArray(r.entries)) r.entries = r.entries.filter((e) => !e?.command?.reelWatchEndpoint?.adClientParams?.isAd);
  return r;
}

/** Called from our interface: open a video in YouTube's TV player. */
export function openInYouTube(item, state) {
  try { sessionStorage.setItem('ytlg.return', JSON.stringify({ ...state, id: item.id, at: Date.now() })); } catch { /* storage unavailable */ }
  const at = Math.floor(resume.get(item.id) || 0);
  location.href = `${TV_URL}#/watch?v=${encodeURIComponent(item.id)}${at ? `&t=${at}s` : ''}`;
}

const videoIdNow = () => (location.hash.match(/[?&]v=([\w-]{11})/) || [])[1] || null;

/** Runs on https://www.youtube.com/tv (top level). */
export function tvMode() {
  // 1) ads: every JSON YouTube parses passes through stripAds (before its code reads it)
  const parse = JSON.parse;
  JSON.parse = function (...a) {
    const r = stripAds(parse.apply(this, a));
    // the played video's channel (our "الجديد" page lists the newest video of channels you watched)
    const d = r && typeof r === 'object' && r.videoDetails;
    if (d?.videoId && d.channelId) {
      try { history.add({ id: d.videoId, title: d.title || '', sub: d.author || '', channelId: d.channelId, duration: '', thumb: `https://i.ytimg.com/vi/${d.videoId}/hqdefault.jpg` }); } catch { /* ignore */ }
    }
    return r;
  };
  const json = Response.prototype.json;
  if (json) Response.prototype.json = function () { return this.text().then((t) => JSON.parse(t)); };

  // 2) "who's watching?" -> continue automatically (youtube-webos auto account select)
  const hookAccounts = () => {
    if (window.__ytlgAccounts || typeof window._yttv !== 'object') return false;
    for (const k in window._yttv) {
      const t = window._yttv[k];
      if (typeof t === 'function' && t.instance && typeof t.instance.resolveCommand === 'function') {
        const orig = t.instance.resolveCommand.bind(t.instance);
        t.instance.resolveCommand = (cmd, extra) => {
          if (cmd && cmd.startAccountSelectorCommand) {
            return orig({
              onIdentityChanged: {
                identityActionContext: { nextEndpoint: cmd.startAccountSelectorCommand.nextEndpoint, eventTrigger: 'ACCOUNT_EVENT_TRIGGER_WHOS_WATCHING', reloadRequired: undefined },
                isSameIdentity: true
              },
              commandMetadata: { webCommandMetadata: { clientAction: true } }
            }, extra);
          }
          return orig(cmd, extra);
        };
        window.__ytlgAccounts = true;
        return true;
      }
    }
    return false;
  };
  const accTimer = setInterval(() => { if (hookAccounts()) clearInterval(accTimer); }, 50);
  setTimeout(() => clearInterval(accTimer), 30000);

  // 3) position memory + SponsorBlock on YouTube's <video>
  let segs = []; let segsFor = null; let lastSaved = -1;
  const loadSegs = (id) => {
    if (segsFor === id) return;
    segsFor = id; segs = [];
    if (settings.get('sb')) sponsorblock.get(id).then((s) => { if (segsFor === id) segs = s; });
  };
  const save = () => {
    const v = document.querySelector('video'); const id = videoIdNow() || segsFor;
    if (v && id && Number.isFinite(v.duration) && v.readyState >= 1) resume.set(id, v.currentTime, v.duration);
  };
  setInterval(() => {
    const v = document.querySelector('video'); const id = videoIdNow();
    if (!v || !id) return;
    loadSegs(id);
    const t = v.currentTime;
    for (const s of segs) {
      if (t >= s.start && t < s.end - 0.5 && !s.done) { s.done = true; v.currentTime = s.end; }
    }
    const sec = Math.floor(t);
    if (sec % 5 === 0 && sec !== lastSaved) { lastSaved = sec; save(); }
  }, 250);

  // 4) back to our interface: as soon as YouTube leaves its player (Back from the video goes to its home),
  //    or the video ends with nothing queued. Back inside YouTube's own menus still closes the menu first.
  let watched = false;
  const goHome = () => { save(); location.replace(`${HOME_URL}#ytlg&back=1`); };
  const check = () => {
    if (/^#\/watch/.test(location.hash)) {
      const v = document.querySelector('video');
      if (v && v.currentTime > 0.5) watched = true; // only once the video really played (not during boot)
      return;
    }
    if (watched) goHome();
  };
  window.addEventListener('hashchange', check);
  setInterval(check, 500);
  // if YouTube shows its own home first (e.g. after the account screen) and loses the video, ask again once
  const want = (() => { try { return JSON.parse(sessionStorage.getItem('ytlg.return') || 'null')?.id; } catch { return null; } })();
  setTimeout(() => {
    if (!watched && want && !/^#\/watch/.test(location.hash)) location.hash = `#/watch?v=${want}`;
  }, 8000);
  console.info('[tvmode] YouTube TV player mode', want || '');
}
