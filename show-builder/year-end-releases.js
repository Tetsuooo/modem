// Looking up releases for the Year-end list tab: one Bandcamp / SoundCloud release →
// one candidate (title, artist, label, cover, tracks, length, release date, type).
// Shared by year-end-gather.js (every release played in a year's shows) and
// year-end.js's "add a release" (a link pasted by hand — last year 3 of the 50 had
// never been played in a show).
//
// Bandcamp pages come from the shared cache in scripts/.cache (the same files the
// SoundCloud matching and the track index read), fetched only if missing.
// SoundCloud lookups are cached per id in show-builder/data/.cache.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { UA, cacheGet, cacheSet } = require('./lib');
const { getClientId } = require('./scan-soundcloud');
const { cachedGet } = require('../scripts/sc-search');

let FRESH = false;
const stats = { bcLive: 0, scLive: 0 };
const setFresh = (v) => { FRESH = !!v; };
const sleep = (ms) => { const t = Date.now() + ms; while (Date.now() < t) { /* polite pause, sync on purpose */ } };

// ---------- release types -------------------------------------------------------------
// A single: one track, or two (an A/B side) that together run under 15 minutes.
// An LP: 7 or more tracks, or 30 minutes and longer. Everything in between: an EP.
// A compilation: tracks by 3 or more different artists, and none by the release's own
// artist — an artist's album with a guest on some tracks isn't one (Jonáš Gruska's
// "Juggler": some tracks have no artist of their own, i.e. they're his). When most titles
// read "Artist - Title" (a label's compilation without per-track artists, like gud serben's
// "GUD LUCK !!"), the part before the dash is the track's artist.
const DASH = /^(.+?)\s+[-–—]\s+(.+)$/;
// "Various Artists", "V/A", "VA", "V.A." — no track is "their own"
const VARIOUS = /^(v\.?\s*[/.]?\s*a\.?|various(\s+artists?)?)$/i;
function typeOf(tracks, totalSeconds, credit) {
  const n = tracks.length;
  const dashed = tracks.filter((t) => DASH.test(t.title || '')).length >= Math.ceil(n * 0.7);
  const credited = String((credit && credit.artist) || '').trim();
  const own = VARIOUS.test(credited) ? '' : credited.toLowerCase();
  const trackArtist = (t) => String(t.artist || (dashed ? (String(t.title || '').match(DASH) || [])[1] : '') || '').trim().toLowerCase();
  const artists = new Set(tracks.map(trackArtist).filter(Boolean));
  const ownTrack = own && tracks.some((t) => { const a = trackArtist(t); return !a || a.includes(own); });
  if (n >= 3 && artists.size >= 3 && !ownTrack) return 'comp';
  if (n <= 1 || (n === 2 && (totalSeconds || 0) < 15 * 60)) return 'single';
  if (n >= 7 || (totalSeconds || 0) >= 30 * 60) return 'LP';
  return 'EP';
}
const SC_SET_TYPES = { album: 'LP', ep: 'EP', single: 'single', compilation: 'comp' };

// "Artist - Title" keys for spotting one release on two platforms (or two pages)
const norm = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\b(ep|lp|album)\b/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const releaseId = (artist, title) => norm(artist) + '|' + norm(title);
const isoDate = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
const origin = (u) => { try { return new URL(u).origin; } catch (e) { return null; } };

// Names and titles without invisible direction marks / zero-width spaces (Bandcamp's
// "Computer man" account is "Computer‎ ‎man") — they'd end up in the list's HTML.
// The zero-width joiner stays: emoji sequences need it.
const INVISIBLE = /[​‎‏‪-‮⁦-⁩﻿]/g;
const clean = (s) => (s == null ? s : String(s).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim());
function tidy(c) {
  if (!c) return c;
  for (const f of ['title', 'artist', 'account', 'label']) c[f] = clean(c[f]);
  (c.tracks || []).forEach((t) => { t.title = clean(t.title); t.artist = clean(t.artist); });
  return c;
}

// ---------- Bandcamp ---------------------------------------------------------------------
function decodeEntities(s) {
  return String(s || '').replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function bcPage(url) {
  const live = {};
  // the same cache file name as scripts/sc-search.js's bcPage()
  const body = cachedGet('bcpage-' + url.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '_') + '.html', url, live, FRESH);
  if (live.hit) { stats.bcLive++; sleep(400); }
  return body;
}
function readTralbum(html) {
  const m = html && html.match(/data-tralbum="([^"]*)"/);
  if (!m) return null;
  try { return JSON.parse(decodeEntities(m[1])); } catch (e) { return null; }
}
function readJsonAttr(html, attr) {
  const m = html && html.match(new RegExp(attr + '="([^"]*)"'));
  if (!m) return null;
  try { return JSON.parse(decodeEntities(m[1])); } catch (e) { return null; }
}
const bcArt = (td) => (td && td.art_id ? `https://f4.bcbits.com/img/a${td.art_id}_16.jpg` : null);

// One Bandcamp album page → a candidate (or null if the page can't be read).
function bandcampAlbumRaw(albumId, albumUrl) {
  const html = bcPage(albumUrl);
  const td = readTralbum(html);
  if (!td) return null;
  const band = readJsonAttr(html, 'data-band') || {};
  const embed = readJsonAttr(html, 'data-embed') || {};
  const tracks = (td.trackinfo || []).map((t) => ({
    id: t.track_id || t.id,
    title: t.title || '',
    artist: t.artist || '',
    url: t.title_link ? new URL(t.title_link, albumUrl).href : null,
    duration: t.duration ? Math.round(t.duration) : null,
    playable: !!(t.file && !t.unreleased_track),
  }));
  const duration = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  const artist = td.artist || embed.artist || band.name || '';
  const account = band.name || '';
  const accountIsLabel = account && account.trim().toLowerCase() !== artist.trim().toLowerCase();
  const id = albumId || td.id; // a standalone track's album: the id comes from its own page
  return {
    key: 'bc:a:' + id,
    source: 'bandcamp',
    kind: 'album',
    albumId: String(id),
    trackId: td.featured_track_id ? String(td.featured_track_id) : null,
    title: embed.album_title || (td.current && td.current.title) || '',
    artist,
    account,
    label: accountIsLabel ? account : null,
    labelFrom: accountIsLabel ? 'account' : null,
    url: albumUrl,
    artistUrl: accountIsLabel ? null : origin(albumUrl),
    labelUrl: accountIsLabel ? origin(albumUrl) : null,
    artwork: bcArt(td),
    releaseDate: isoDate(td.album_release_date || (td.current && (td.current.release_date || td.current.publish_date))),
    trackCount: tracks.length,
    duration: duration || null,
    type: typeOf(tracks, duration, { artist, account }),
    tracks,
  };
}

// A Bandcamp track page → its album's candidate if it's on one, else a single.
function bandcampTrackRaw(trackUrl, trackId) {
  const html = bcPage(trackUrl);
  const td = readTralbum(html);
  if (!td) return null;
  const albumPath = td.album_url || (td.current && td.current.album_url);
  if (albumPath) {
    const album = bandcampAlbum(null, new URL(albumPath, trackUrl).href);
    if (album) return album;
  }
  const band = readJsonAttr(html, 'data-band') || {};
  const tr = (td.trackinfo || [])[0] || {};
  const id = String(trackId || tr.track_id || td.id);
  const duration = tr.duration ? Math.round(tr.duration) : null;
  const artist = td.artist || band.name || '';
  const accountIsLabel = band.name && band.name.trim().toLowerCase() !== artist.trim().toLowerCase();
  return {
    key: 'bc:t:' + id, source: 'bandcamp', kind: 'track', albumId: null, trackId: id,
    title: tr.title || (td.current && td.current.title) || '', artist, account: band.name || artist,
    label: accountIsLabel ? band.name : null, labelFrom: accountIsLabel ? 'account' : null,
    url: trackUrl, artistUrl: accountIsLabel ? null : origin(trackUrl), labelUrl: accountIsLabel ? origin(trackUrl) : null,
    artwork: bcArt(td),
    releaseDate: isoDate(td.current && (td.current.release_date || td.current.publish_date)),
    trackCount: 1, duration, type: 'single',
    tracks: [{ id: tr.track_id || id, title: tr.title || '', artist: tr.artist || '', url: trackUrl, duration, playable: !!tr.file }],
  };
}

// ---------- SoundCloud -----------------------------------------------------------------------
let scClientId = null;
function scGet(pathAndQuery) {
  if (!scClientId) scClientId = getClientId(false);
  const call = () => {
    const u = 'https://api-v2.soundcloud.com' + pathAndQuery + (pathAndQuery.includes('?') ? '&' : '?') + 'client_id=' + scClientId;
    const out = execFileSync('curl', ['-sS', '--max-time', '25', '-A', UA, '-w', '\n%{http_code}', u], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const i = out.lastIndexOf('\n');
    return { status: Number(out.slice(i + 1)), body: out.slice(0, i) };
  };
  let r = call();
  if (r.status === 401 || r.status === 403) { scClientId = getClientId(true); r = call(); }
  stats.scLive++;
  sleep(200);
  if (r.status === 404) return null;
  if (r.status >= 400) throw new Error(`SoundCloud ${r.status}: ${pathAndQuery}`);
  return JSON.parse(r.body);
}
// cached per id in show-builder/data/.cache — albums don't change what they contain
function scCached(key, fetch) {
  if (!FRESH) { const c = cacheGet(key); if (c) return c.value; }
  const value = fetch();
  cacheSet(key, { value, at: new Date().toISOString() });
  return value;
}
// look without fetching (undefined = not cached), and store
const scPeek = (key) => { if (FRESH) return undefined; const c = cacheGet(key); return c ? c.value : undefined; };
const scPut = (key, value) => cacheSet(key, { value, at: new Date().toISOString() });
const scArt = (u) => (u ? u.replace('-large.', '-t500x500.') : null);

// The albums / EPs a SoundCloud track is on (api-v2's own "In albums").
function scAlbumsOf(trackId) {
  return scCached('ye-sc-albums-' + trackId, () => {
    const j = scGet(`/tracks/${trackId}/albums?limit=10`);
    return ((j && j.collection) || []).map((p) => ({ ...p, tracks: (p.tracks || []).slice(0, 60) }));
  });
}

// An account's own plain playlists (not albums). Some artists put an album up as a playlist
// (2026-11-20, Matej: ant. adventure's "The broken umbrellas trick" — "those should count
// too"), and SoundCloud's "in playlists" for a track leaves out the uploader's own playlist,
// so the account is asked. Cached for a week: unlike an album's contents, an account's
// playlists change.
const OWN_SETS_DAYS = 7;
function scOwnPlaylists(userId) {
  const key = 'ye-sc-user-sets-' + userId;
  if (!FRESH) {
    const c = cacheGet(key);
    if (c && Date.now() - Date.parse(c.at) < OWN_SETS_DAYS * 864e5) return c.value;
  }
  const out = [];
  let next = `/users/${userId}/playlists_without_albums?limit=50`;
  for (let page = 0; next && page < 4; page++) {
    const j = scGet(next);
    for (const p of (j && j.collection) || []) out.push({ ...p, tracks: (p.tracks || []).slice(0, 60) });
    // next_href is a whole address with its own client_id: keep the path and the rest
    next = null;
    if (j && j.next_href) {
      const u = new URL(j.next_href);
      u.searchParams.delete('client_id');
      next = u.pathname + u.search;
    }
  }
  cacheSet(key, { value: out, at: new Date().toISOString() });
  return out;
}

// The uploader's own playlist a track is on, as its release: 2–40 tracks (an album, not an
// "everything" playlist), only the uploader's own tracks as far as SoundCloud shows them
// (not a mix of other people's), the smallest such one. null = none.
const OWN_SET_MAX = 40;
function scOwnPlaylistOf(track) {
  const owner = track && ((track.user && track.user.id) || track.user_id);
  if (!owner) return null;
  const ownerOf = (x) => (x.user && x.user.id) || x.user_id;
  const sets = scOwnPlaylists(owner).filter((p) =>
    ownerOf(p) === owner && p.track_count >= 2 && p.track_count <= OWN_SET_MAX &&
    (p.tracks || []).some((t) => String(t.id) === String(track.id)) &&
    (p.tracks || []).filter(ownerOf).every((t) => ownerOf(t) === owner));
  sets.sort((a, b) => a.track_count - b.track_count);
  return sets[0] || null;
}

function soundcloudSetRaw(p) {
  if (!p) return null;
  const tracks = (p.tracks || []).map((t) => ({
    id: t.id,
    title: t.title || null, // api-v2 only fills the first few; the tab resolves the rest
    artist: (t.publisher_metadata && t.publisher_metadata.artist) || (t.user && t.user.username) || '',
    url: t.permalink_url || null,
    duration: t.duration ? Math.round(t.duration / 1000) : null,
    playable: true,
  }));
  const duration = p.duration ? Math.round(p.duration / 1000) : null;
  const user = p.user || {};
  // a plain playlist: typed by its tracks, as the account's own — its tracks credited to
  // "ant. adventure.ᐟ", "… mouseman", "… porkbelly" are one artist's album, not a compilation
  const type = SC_SET_TYPES[p.set_type] || typeOf(tracks.length ? tracks : new Array(p.track_count || 0).fill({}), duration, { artist: user.username });
  const label = p.label_name || null;
  return {
    key: 'sc:p:' + p.id,
    source: 'soundcloud',
    kind: 'set',
    scId: String(p.id),
    setType: p.set_type || 'playlist',
    title: p.title || '',
    artist: user.username || '',
    account: user.username || '',
    label,
    labelFrom: label ? 'soundcloud' : null,
    url: p.permalink_url,
    artistUrl: user.permalink_url || null,
    labelUrl: null,
    artwork: scArt(p.artwork_url || (p.tracks && p.tracks[0] && p.tracks[0].artwork_url)),
    releaseDate: isoDate(p.release_date || p.published_at || p.created_at),
    trackCount: p.track_count || tracks.length,
    duration,
    type,
    tracks,
  };
}

function soundcloudSingleRaw(t) {
  if (!t) return null;
  const duration = t.duration ? Math.round(t.duration / 1000) : null;
  const pm = t.publisher_metadata || {};
  return {
    key: 'sc:t:' + t.id,
    source: 'soundcloud',
    kind: 'track',
    scId: String(t.id),
    title: t.title || '',
    artist: pm.artist || (t.user && t.user.username) || '',
    account: (t.user && t.user.username) || '',
    label: null,
    labelFrom: null,
    url: t.permalink_url,
    artistUrl: (t.user && t.user.permalink_url) || null,
    labelUrl: null,
    artwork: scArt(t.artwork_url || (t.user && t.user.avatar_url)),
    releaseDate: isoDate(t.release_date || t.display_date || t.created_at),
    trackCount: 1,
    duration,
    type: 'single',
    tracks: [{ id: t.id, title: t.title || '', artist: pm.artist || '', url: t.permalink_url, duration, playable: true }],
  };
}

// ---------- a pasted link → a release ----------------------------------------------------------
// Bandcamp: an album page → that album; a track page → its album, or the track as a single.
// SoundCloud: a set → that set; a track → the album / EP it's on, else the uploader's own
// playlist it's on (scOwnPlaylistOf), or the track as a single.
function releaseFromUrl(raw) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch (e) { throw new Error('not a link'); }
  if (/(^|\.)soundcloud\.com$/i.test(url.hostname)) {
    const clean = url.origin.replace('m.soundcloud.com', 'soundcloud.com') + url.pathname.replace(/\/$/, '');
    const r = scGet('/resolve?url=' + encodeURIComponent(clean));
    if (!r) throw new Error('SoundCloud doesn\'t know this link');
    if (r.kind === 'playlist') return soundcloudSet(r);
    if (r.kind === 'track') {
      const sets = scAlbumsOf(r.id).filter((p) => p.set_type !== 'single');
      if (sets.length) return soundcloudSet(sets[0]);
      const own = scOwnPlaylistOf(r);
      return own ? soundcloudSet(own) : soundcloudSingle(r);
    }
    throw new Error('that SoundCloud link isn\'t a track or a set');
  }
  // Bandcamp, also on an artist's own domain: the page says what it is
  const page = url.origin + url.pathname.replace(/\/$/, '');
  const td = readTralbum(bcPage(page));
  if (!td) throw new Error('couldn\'t read a Bandcamp release on that page');
  if (td.item_type === 'album' || /\/album\//.test(url.pathname)) return bandcampAlbum(null, page);
  return bandcampTrack(page, td.id);
}

// ---------- the show being built ----------------------------------------------------------------
// The draft, for Gather to count like a published show (Matej, 2026-11-20: the list
// "should not wait until a release is published in a show … it could also add albums that are
// part of the current show build"): data/current-draft.json, or Sync's shared-draft.json (the
// other computer's draft) when that's newer. Its show number, air date (→ the year) and
// tracks, with the artists and labels typed in Arrange. `sig` says whether it changed since a
// gather (the tab gathers again by itself then). null = no draft, or an empty one.
const DRAFT_FILES = ['current-draft.json', 'shared-draft.json'].map((f) => path.join(__dirname, 'data', f));
function showInTheWorks() {
  let best = null;
  for (const f of DRAFT_FILES) {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const at = Math.max(fs.statSync(f).mtimeMs, Number(d.savedAt) || 0);
      if (d && Array.isArray(d.selected) && (!best || at > best.at)) best = { d, at };
    } catch (e) { /* no such draft */ }
  }
  if (!best || !best.d.selected.length) return null;
  const d = best.d;
  const entries = d.selected.map((it) => ({
    key: String(it.key || ''), source: it.source || '', url: it.url || null,
    albumId: it.albumId ? String(it.albumId) : null, trackId: it.trackId ? String(it.trackId) : null, isPlaylist: !!it.isPlaylist,
    artists: [it.artist, ...(it.extraArtists || [])].filter(Boolean),
    labels: [it.label, ...(it.extraLabels || [])].filter(Boolean),
  }));
  const number = Number(d.showNumber) || null;
  const airDate = d.airDate || null;
  const year = Number((String(airDate || '').match(/(\d{4})\s*$/) || [])[1]) || new Date().getFullYear();
  const sig = crypto.createHash('sha1').update(JSON.stringify([number, airDate, entries])).digest('hex').slice(0, 16);
  return { number, airDate, year, entries, sig };
}

// every release comes out tidied (see tidy)
const bandcampAlbum = (...a) => tidy(bandcampAlbumRaw(...a));
const bandcampTrack = (...a) => tidy(bandcampTrackRaw(...a));
const soundcloudSet = (...a) => tidy(soundcloudSetRaw(...a));
const soundcloudSingle = (...a) => tidy(soundcloudSingleRaw(...a));

module.exports = {
  stats, setFresh, typeOf, norm, releaseId, isoDate, origin,
  bcPage, readTralbum, bandcampAlbum, bandcampTrack,
  scGet, scCached, scPeek, scPut, scAlbumsOf, scOwnPlaylistOf, soundcloudSet, soundcloudSingle, releaseFromUrl,
  showInTheWorks,
};
