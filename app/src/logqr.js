// Log -> one QR code. The log is first compacted (repeats collapsed, long tokens and stack traces removed).
// If it fits, the QR holds the plain text (readable straight on the phone); otherwise it holds a link to
// log.html with the log deflate-compressed in the #fragment (the fragment never leaves the phone).

export const VIEWER = 'https://ahmad-ksa.github.io/youtube2/log.html';
const MAX_BYTES = 2900; // QR version 40, error level L holds 2953 bytes

const utf8 = (s) => unescape(encodeURIComponent(s)); // binary string, one char per UTF-8 byte

/** Removes noise that does not help diagnosis, then collapses repeated lines and repeated blocks. */
export function compactLogs(lines) {
  const clean = lines.map((l) => String(l)
    .replace(/,?"stack":"(?:[^"\\]|\\.)*"?/g, '') // shaka error objects carry a JS stack
    .replace(/\n\s+at .*/g, '') // stack traces
    .replace(/[A-Za-z0-9_\-%=+/]{40,}/g, '…') // reload tokens, URLs' long query values, base64
    .trim());
  const out = []; // { text, n }
  let i = 0;
  while (i < clean.length) {
    // longest block (1..4 lines) that repeats right after itself
    let done = false;
    for (let p = 4; p >= 1 && !done; p--) {
      if (i + 2 * p > clean.length) continue;
      const block = clean.slice(i, i + p);
      let reps = 1;
      while (i + (reps + 1) * p <= clean.length && block.every((l, k) => clean[i + reps * p + k] === l)) reps++;
      if (reps > 1) {
        block.forEach((l, k) => out.push(k === p - 1 ? `${l}   ↺ ×${reps}${p > 1 ? ` (آخر ${p} أسطر)` : ''}` : l));
        i += reps * p; done = true;
      }
    }
    if (!done) { out.push(clean[i]); i++; }
  }
  return out;
}

async function deflate(text) {
  const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Picks the best single-QR form for the log. data is ready for qrcode-generator's 'Byte' mode. */
export async function logQrPayload(header, lines) {
  const text = (ls) => header + '\n' + ls.join('\n');
  const all = text(lines);
  if (utf8(all).length <= MAX_BYTES) return { kind: 'text', data: utf8(all), lines: lines.length };

  if (typeof CompressionStream !== 'undefined') {
    let ls = lines;
    for (;;) {
      const url = VIEWER + '#' + await deflate(text(ls));
      if (url.length <= MAX_BYTES) return { kind: ls.length === lines.length ? 'link' : 'tail', data: url, lines: ls.length };
      if (ls.length <= 1) break;
      ls = ls.slice(Math.ceil(ls.length * 0.1)); // drop the oldest 10% and try again
    }
  }
  // no compression available: newest lines that fit as plain text
  let ls = lines;
  while (ls.length > 1 && utf8(text(ls)).length > MAX_BYTES) ls = ls.slice(1);
  let t = utf8(text(ls));
  if (t.length > MAX_BYTES) t = t.slice(0, MAX_BYTES);
  return { kind: 'tail', data: t, lines: ls.length };
}
