// Flags scan-result tracks/albums that already appeared in a previous modem
// show, by matching against the flat track index scripts/build-track-index.js
// writes into src/assets/modem-archive.json's `tracks` field (same file/shape
// the live site's search uses) — no separate index to maintain.
//
// Key spaces must match build-track-index.js's keyOf() exactly:
//   soundcloud: 'sc:' + <numeric track id>
//   bandcamp:   'bc:' + (albumId||'-') + ':' + (trackId||'-')
// scan-soundcloud.js's item.key is already 'sc:'+id, so it's used directly.
// scan-bandcamp.js's item.key is 'bc:'+tralbum_id (single id, ambiguous
// whether that's an album or track id) — NOT the same shape, so bandcamp
// matches are built from item.albumId/trackId instead, never item.key.
const fs = require('fs');
const path = require('path');

const ARCHIVE_FILE = path.join(__dirname, '..', 'src', 'assets', 'modem-archive.json');

let cache = null; // { mtimeMs, scByTrack, bcByKey, bcByAlbum }

function showNumbers(entries) {
  const nums = new Set();
  for (const t of entries) for (const s of t.shows || []) if (s.number != null) nums.add(s.number);
  return [...nums].sort((a, b) => a - b);
}

function loadIndex() {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(ARCHIVE_FILE).mtimeMs;
  } catch (e) {
    return null; // archive not built yet — best-effort, just skip flagging
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache;

  const data = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  const scByTrack = new Map();
  const bcByKey = new Map();
  const bcByAlbum = new Map();
  for (const t of data.tracks || []) {
    if (t.kind === 'soundcloud') {
      const id = String(t.key || '').replace(/^sc:/, '');
      if (id) scByTrack.set(id, t);
    } else if (t.kind === 'bandcamp') {
      bcByKey.set(t.key, t);
      const m = /^bc:([^:]+):/.exec(t.key || '');
      const albumId = m && m[1] !== '-' ? m[1] : null;
      if (albumId) {
        if (!bcByAlbum.has(albumId)) bcByAlbum.set(albumId, []);
        bcByAlbum.get(albumId).push(t);
      }
    }
  }
  cache = { mtimeMs, scByTrack, bcByKey, bcByAlbum };
  return cache;
}

// item: { source, key?, albumId?, trackId? } — either a show-builder scan
// result or a resolved sub-track. Returns null (no match) or
// { matchType: 'track'|'album', shows: [showNumber, ...] }.
function checkDuplicate(item) {
  const idx = loadIndex();
  if (!idx) return null;

  if (item.source === 'soundcloud') {
    const id = String(item.key || '').replace(/^sc:/, '');
    if (!id) return null;
    const entry = idx.scByTrack.get(id);
    return entry ? { matchType: 'track', shows: showNumbers([entry]) } : null;
  }

  const albumId = item.albumId || null;
  const trackId = item.trackId || null;
  if (!albumId && !trackId) return null;

  const exact = idx.bcByKey.get('bc:' + (albumId || '-') + ':' + (trackId || '-'));
  if (exact) return { matchType: 'track', shows: showNumbers([exact]) };

  // No exact track match, but a DIFFERENT track off the same release was
  // featured before — still worth flagging per "tracks or albums".
  if (albumId && idx.bcByAlbum.has(albumId)) {
    return { matchType: 'album', shows: showNumbers(idx.bcByAlbum.get(albumId)) };
  }
  return null;
}

module.exports = { checkDuplicate };
