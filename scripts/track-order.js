/*
 * track-order.js — moving the tracks under one heading of a show page (the show builder's
 * Edit site tab: ▲/▼ on a track; Matej, 2026-10-25).
 *
 * overrides.json "orderEdits":
 *   { "<record slug>": { "<seg>": { "base": ["<player src>", …], "order": ["<player src>", …] } } }
 * One entry per heading whose tracks were moved. A player is a track's <iframe>, named by its
 * src (&amp; decoded — the track index's embedSrc is sometimes encoded, sometimes not).
 * `base` = the heading's players in their original order, `order` = the order they should
 * have.
 *
 * apply-overrides.js moves them (applyOrderEdit), in the record's bodyHtml:
 *   - players each in their own paragraph: a player moves together with a credit line right
 *     after it (SoundCloud's embed code puts "artist · title" there, in a <div>); anything
 *     else (text, headings' own lines) stays where it is;
 *   - players packed into one paragraph (a release's small players): they swap places, and
 *     everything around them stays.
 * It moves them only while the heading has exactly these players in the original order (or
 * already in the new one). Otherwise, e.g. a show published again from the builder with other
 * tracks or another order, the heading is left as it is and the run says so: the newer order
 * wins.
 *
 * Once applied, the archive holds the new order, not the original. Moving a heading's tracks
 * again or putting them back therefore needs the original, so overrides-diff.js counts a
 * changed or removed order as a take-back and the publish re-derives the archive from source
 * first, the same as an undone tag edit.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const MARKER = /<p data-seg="(\d+)" class="seg-marker">[\s\S]*?<\/p>/g;
const PLAYER = /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi;

const decode = (s) => String(s == null ? '' : s).replace(/&amp;/g, '&');
const srcOf = (iframe) => decode((iframe.match(/\ssrc="([^"]*)"/i) || [])[1] || '');

// The html between a heading's marker and the next marker: { start, end } in body, or null.
function segmentBounds(body, seg) {
  const marks = [];
  let m;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(body))) marks.push({ seg: Number(m[1]), start: m.index, end: MARKER.lastIndex });
  const i = marks.findIndex((x) => x.seg === Number(seg));
  if (i < 0) return null;
  return { start: marks[i].end, end: i + 1 < marks.length ? marks[i + 1].start : body.length };
}

// The players of every heading, in page order: { <seg>: [src, …] }.
function playersBySeg(body) {
  const out = {};
  const marks = [];
  let m;
  MARKER.lastIndex = 0;
  while ((m = MARKER.exec(body || ''))) marks.push({ seg: Number(m[1]), end: MARKER.lastIndex, start: m.index });
  marks.forEach((mk, i) => {
    const html = body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : body.length);
    out[mk.seg] = (html.match(PLAYER) || []).map(srcOf);
  });
  return out;
}

// An html fragment cut into its top-level elements and the text between them; joined
// back together they are exactly the fragment.
function pieces(html) {
  const out = [];
  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  let depth = 0, start = 0, m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    const tag = m[1].toLowerCase();
    const closing = m[0][1] === '/';
    const selfClosing = /\/>$/.test(m[0]) || VOID.has(tag);
    if (depth === 0 && !closing && m.index > start) { out.push(html.slice(start, m.index)); start = m.index; }
    if (closing) depth = Math.max(0, depth - 1);
    else if (!selfClosing) depth++;
    if (depth === 0) { out.push(html.slice(start, re.lastIndex)); start = re.lastIndex; }
  }
  if (start < html.length) out.push(html.slice(start));
  return out;
}

const countPlayers = (html) => (html.match(PLAYER) || []).length;
const isCreditLine = (p) => /^\s*<div\b/i.test(p) && !countPlayers(p) && /(soundcloud|bandcamp)\.com/i.test(p);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a, b) => sameList(a.slice().sort(), b.slice().sort());

// For each wanted src, the index of an unused current item with that src (handles a player
// that appears twice).
function permutation(currentSrcs, wanted) {
  const used = new Set();
  return wanted.map((src) => {
    const i = currentSrcs.findIndex((s, k) => s === src && !used.has(k));
    used.add(i);
    return i;
  });
}

// The heading's html with its players in `order` (a list of srcs, the same players).
function reorderSegment(html, order) {
  const parts = pieces(html);
  if (parts.some((p) => countPlayers(p) > 1)) {
    // packed: swap the players in their places
    const players = html.match(PLAYER) || [];
    const perm = permutation(players.map(srcOf), order);
    let k = 0;
    return html.replace(PLAYER, () => players[perm[k++]]);
  }
  // one player per paragraph: a unit = the player's paragraph + the whitespace and credit
  // line right after it; the rest stays put
  const units = [];
  const unitAt = new Map(); // piece index → unit index (first piece of a unit)
  const inUnit = new Set();
  for (let i = 0; i < parts.length; i++) {
    if (countPlayers(parts[i]) !== 1) continue;
    const unit = [i];
    let j = i + 1;
    while (j < parts.length && (!parts[j].trim() || isCreditLine(parts[j]))) unit.push(j++);
    // trailing whitespace without a credit line after it stays outside the unit
    while (unit.length > 1 && !parts[unit[unit.length - 1]].trim()) unit.pop();
    unitAt.set(i, units.length);
    unit.forEach((k) => inUnit.add(k));
    units.push({ html: unit.map((k) => parts[k]).join(''), src: srcOf(parts[i].match(PLAYER)[0]) });
    i = unit[unit.length - 1];
  }
  const perm = permutation(units.map((u) => u.src), order);
  let next = 0;
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (unitAt.has(i)) out += units[perm[next++]].html;
    else if (!inUnit.has(i)) out += parts[i];
  }
  return out;
}

// Apply one heading's order edit to a record's bodyHtml.
// → { body, status: 'moved' | 'same' | 'changed' | 'missing', detail }
function applyOrderEdit(body, seg, edit) {
  const b = segmentBounds(body || '', seg);
  if (!b) return { body, status: 'missing', detail: 'no such heading' };
  const html = body.slice(b.start, b.end);
  const cur = (html.match(PLAYER) || []).map(srcOf);
  const order = ((edit && edit.order) || []).map(decode);
  const base = edit && Array.isArray(edit.base) ? edit.base.map(decode) : null;
  if (!sameSet(cur, order)) return { body, status: 'changed', detail: 'its tracks changed since the move' };
  if (sameList(cur, order)) return { body, status: 'same' };
  if (base && !sameList(cur, base)) return { body, status: 'changed', detail: 'its tracks were put in another order since the move' };
  const moved = reorderSegment(html, order);
  return { body: body.slice(0, b.start) + moved + body.slice(b.end), status: 'moved' };
}

// A record's embeds list in the order its players now have in bodyHtml.
function orderEmbeds(embeds, body) {
  const srcs = (String(body || '').match(PLAYER) || []).map(srcOf);
  const used = new Set();
  const out = [];
  srcs.forEach((src) => {
    const i = embeds.findIndex((e, k) => !used.has(k) && decode(e && e.src) === src);
    if (i >= 0) { used.add(i); out.push(embeds[i]); }
  });
  embeds.forEach((e, k) => { if (!used.has(k)) out.push(e); });
  return out;
}

module.exports = { applyOrderEdit, orderEmbeds, playersBySeg, reorderSegment, pieces, decode };
