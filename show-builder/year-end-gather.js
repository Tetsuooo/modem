#!/usr/bin/env node
// "Year-end list" tab, step 1: every LP / EP / compilation played in a year's shows.
//
// Reads the site's archive (src/assets/modem-archive.json): every show aired in the
// year, every Bandcamp / SoundCloud embed in it. Then, per release (lookups in
// year-end-releases.js):
//   - Bandcamp: the album's own page (tracks, lengths, release date, the account it's
//     on). A standalone Bandcamp track is a single, unless its page says it's on an album.
//   - SoundCloud: the album / EP a played track is on, and playlists embedded as a whole.
// Each release gets a type from its tracks and length (typeOf) or, on SoundCloud, from
// what the uploader marked it as. The same release on Bandcamp and SoundCloud (or on two
// Bandcamp pages) becomes one entry. Labels tagged in the shows win over the account's.
//
// Writes data/year-end.json → [year].candidates (+ gatheredAt, shows). The picks and the
// order (decisions / order, saved by the tab) are left as they are — the file is read
// again right before writing, so picks saved while this ran aren't lost. Releases added
// by hand (addedByHand) are kept too.
//
// Checked against the published "best releases of 2025": every one of its releases that
// was played in a 2025 show is found (42 of 49; the other 7 were played in January 2026
// or never in a show), none of them taken for a single.
//
// Usage: node show-builder/year-end-gather.js [--year 2026] [--fresh] [--out file]
//   --fresh  look everything up again (ignore both caches)
//   --out    write somewhere else (tests); default data/year-end.json
const fs = require('fs');
const path = require('path');
const R = require('./year-end-releases');

const ROOT = path.join(__dirname, '..');
const ARCHIVE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');

const argv = process.argv.slice(2);
const argVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const YEAR = Number(argVal('--year')) || new Date().getFullYear();
R.setFresh(argv.includes('--fresh'));
const OUT = argVal('--out') ? path.resolve(argVal('--out')) : path.join(__dirname, 'data', 'year-end.json');
const log = (s) => console.log(s);

function bandcampIds(src) {
  return { albumId: (src.match(/album=(\d+)/) || [])[1] || null, trackId: (src.match(/track=(\d+)/) || [])[1] || null };
}
function soundcloudIds(src) {
  let u = (src.match(/[?&]url=([^&]+)/) || [])[1] || '';
  for (let i = 0; i < 3 && /%[0-9a-f]{2}/i.test(u); i++) { try { u = decodeURIComponent(u); } catch (e) { break; } }
  return { id: (u.match(/(\d{5,})/) || [])[1] || null, isPlaylist: /playlists/.test(u) };
}
const yearOf = (date) => Number((String(date || '').match(/(\d{4})\s*$/) || [])[1]) || null;

function main() {
  const archive = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
  const shows = (archive.records || []).filter((r) => r.type === 'show' && yearOf(r.date) === YEAR)
    .sort((a, b) => (a.number || 0) - (b.number || 0));
  if (!shows.length) throw new Error('no shows from ' + YEAR + ' in the archive');
  log(`${shows.length} shows from ${YEAR}: modem ${shows[0].number}–${shows[shows.length - 1].number}`);
  const index = archive.tracks || [];
  const indexByKey = new Map(index.map((t) => [t.key, t]));
  const tagLabels = (key, number) => {
    const t = indexByKey.get(key);
    const s = t && (t.shows || []).find((x) => x.number === number);
    return (s && s.labels) || [];
  };

  // played[releaseKey] = { shows: Map(number -> Set(trackId)), labels: Map(label -> count) }
  const played = new Map();
  const note = (key, number, trackId, labels) => {
    if (!played.has(key)) played.set(key, { shows: new Map(), labels: new Map() });
    const p = played.get(key);
    if (!p.shows.has(number)) p.shows.set(number, new Set());
    if (trackId) p.shows.get(number).add(String(trackId));
    for (const l of labels || []) p.labels.set(l, (p.labels.get(l) || 0) + 1);
  };

  const bcAlbums = new Map(); // albumId -> albumUrl
  const bcLooseTracks = [];   // [{ trackId, number, link, labels }]
  const scTracks = [];        // [{ id, number, labels }]
  const scSets = new Set();
  for (const s of shows) {
    for (const e of s.embeds || []) {
      if (e.kind === 'bandcamp') {
        const { albumId, trackId } = bandcampIds(e.src);
        if (albumId) {
          const it = indexByKey.get(`bc:${albumId}:${trackId}`) || index.find((t) => t.key.startsWith(`bc:${albumId}:`));
          if (it && it.albumUrl && !bcAlbums.has(albumId)) bcAlbums.set(albumId, it.albumUrl);
          note('bc:a:' + albumId, s.number, trackId, tagLabels(`bc:${albumId}:${trackId}`, s.number));
        } else if (trackId) {
          const it = index.find((t) => t.kind === 'bandcamp' && t.key.endsWith(':' + trackId));
          bcLooseTracks.push({ trackId, number: s.number, link: it && it.link, labels: it ? tagLabels(it.key, s.number) : [] });
        }
      } else if (e.kind === 'soundcloud') {
        const { id, isPlaylist } = soundcloudIds(e.src);
        if (!id) continue;
        if (isPlaylist) { scSets.add(id); note('sc:p:' + id, s.number, null, []); }
        else scTracks.push({ id, number: s.number, labels: tagLabels('sc:' + id, s.number) });
      }
    }
  }
  log(`found: ${bcAlbums.size} Bandcamp albums, ${bcLooseTracks.length} standalone Bandcamp tracks, ${scTracks.length} SoundCloud tracks, ${scSets.size} SoundCloud playlists`);

  const candidates = new Map(); // key -> candidate
  const add = (c) => { if (c && !candidates.has(c.key)) candidates.set(c.key, c); return c && candidates.get(c.key); };

  let n = 0;
  for (const [albumId, albumUrl] of bcAlbums) {
    n++;
    const c = add(R.bandcampAlbum(albumId, albumUrl));
    log(`[bandcamp ${n}/${bcAlbums.size}] ${c ? `${c.artist} – ${c.title} (${c.type})` : 'could not read ' + albumUrl}`);
  }
  for (const t of bcLooseTracks) {
    if (!t.link) continue;
    const c = add(R.bandcampTrack(t.link, t.trackId));
    if (c) { note(c.key, t.number, t.trackId, t.labels); log(`[bandcamp track] ${c.kind === 'album' ? 'on an album' : 'a single'}: ${c.artist} – ${c.title}`); }
  }

  // SoundCloud: the album / EP a played track is on, else the track itself (a single)
  n = 0;
  const singles = [];
  for (const t of scTracks) {
    n++;
    const sets = R.scAlbumsOf(t.id).filter((p) => p.set_type !== 'single');
    if (sets.length) {
      const c = add(R.soundcloudSet(sets[0]));
      note(c.key, t.number, t.id, t.labels);
      if (n % 10 === 0 || n === scTracks.length) log(`[soundcloud ${n}/${scTracks.length}] on ${c.type}: ${c.artist} – ${c.title}`);
    } else {
      singles.push(t);
      if (n % 10 === 0 || n === scTracks.length) log(`[soundcloud ${n}/${scTracks.length}] a single`);
    }
  }
  // singles: the tracks' own details, 50 per call
  const missing = singles.filter((t) => !R.scPeek('ye-sc-track-' + t.id));
  for (let i = 0; i < missing.length; i += 50) {
    const batch = R.scGet('/tracks?ids=' + missing.slice(i, i + 50).map((t) => t.id).join(',')) || [];
    for (const tr of batch) R.scPut('ye-sc-track-' + tr.id, tr);
  }
  for (const t of singles) {
    const cand = add(R.soundcloudSingle(R.scPeek('ye-sc-track-' + t.id)));
    if (cand) note(cand.key, t.number, t.id, t.labels);
  }
  for (const id of scSets) {
    const c = R.soundcloudSet(R.scCached('ye-sc-set-' + id, () => R.scGet('/playlists/' + id)));
    if (c) { add(c); log(`[soundcloud set] ${c.artist} – ${c.title} (${c.type})`); }
  }

  // the shows each release was played in, and labels from the shows' own tags
  for (const c of candidates.values()) {
    const p = played.get(c.key);
    c.shows = p ? [...p.shows.entries()].sort((a, b) => a[0] - b[0]).map(([number, ids]) => ({ number, tracks: [...ids] })) : [];
    c.playedTracks = c.shows.reduce((s, x) => s + Math.max(1, x.tracks.length), 0);
    // the label tagged in the shows wins; its link only if it's the account the release is on
    const tagged = p ? [...p.labels.entries()].sort((a, b) => b[1] - a[1])[0] : null;
    if (tagged && tagged[0]) {
      const same = (c.account || '').trim().toLowerCase() === tagged[0].trim().toLowerCase();
      c.label = tagged[0];
      c.labelFrom = 'tag';
      c.labelUrl = same && c.source === 'bandcamp' ? R.origin(c.url) : null;
    }
    c.year = c.releaseDate ? Number(c.releaseDate.slice(0, 4)) : null;
  }

  // one release, two places (Bandcamp + SoundCloud, or two Bandcamp pages): keep one.
  // Known as "artist + title" — and, for a title like "Dj-c - Night of the living liquor
  // store" (SoundCloud sets often carry the artist in the title), also as that artist + title.
  // Only with a real title: titles that are just symbols ("-", "🛞", invisible marks) would all
  // read as the same empty title, and an artist's untitled tracks would become one release.
  const idsOf = (c) => {
    const ids = [];
    if (R.norm(c.title)) ids.push(R.releaseId(c.artist, c.title));
    const m = String(c.title || '').match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m && R.norm(m[1]) && R.norm(m[2])) ids.push(R.releaseId(m[1], m[2]));
    return ids.length ? ids : ['key:' + c.key];
  };
  const byRelease = new Map();
  for (const c of [...candidates.values()].filter((x) => x.shows.length)) {
    const ids = idsOf(c);
    const keep = ids.map((i) => byRelease.get(i)).find(Boolean);
    if (!keep) { ids.forEach((i) => byRelease.set(i, c)); continue; }
    // Bandcamp first (the lists embed Bandcamp), then the one with more tracks
    const [a, b] = (keep.source === 'bandcamp' && c.source !== 'bandcamp') || (keep.source === c.source && (keep.trackCount || 0) >= (c.trackCount || 0)) ? [keep, c] : [c, keep];
    a.alsoOn = [...(a.alsoOn || []), { source: b.source, url: b.url, key: b.key }];
    const shows = new Map(a.shows.map((s) => [s.number, new Set(s.tracks)]));
    for (const s of b.shows) { if (!shows.has(s.number)) shows.set(s.number, new Set()); s.tracks.forEach((t) => shows.get(s.number).add(t)); }
    a.shows = [...shows.entries()].sort((x, y) => x[0] - y[0]).map(([number, ids]) => ({ number, tracks: [...ids] }));
    a.playedTracks = a.shows.reduce((s, x) => s + Math.max(1, x.tracks.length), 0);
    if (!a.label && b.label) { a.label = b.label; a.labelFrom = b.labelFrom; }
    [...ids, ...idsOf(keep)].forEach((i) => byRelease.set(i, a));
  }
  const list = [...new Set(byRelease.values())].sort((a, b) =>
    (b.playedTracks - a.playedTracks) || (b.shows.length - a.shows.length) || String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));

  const counts = list.reduce((m, c) => { m[c.type] = (m[c.type] || 0) + 1; return m; }, {});
  log(`${list.length} releases: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')} (fetched live: ${R.stats.bcLive} Bandcamp pages, ${R.stats.scLive} SoundCloud calls)`);

  // write — re-read first, so picks (and releases added by hand) saved meanwhile stay
  let all = {};
  try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { all = {}; }
  const y = all[YEAR] || { decisions: {}, order: [] };
  const gathered = new Set(list.map((c) => c.key));
  const byHand = (y.candidates || []).filter((c) => c.addedByHand && !gathered.has(c.key));
  y.candidates = [...list, ...byHand];
  y.gatheredAt = new Date().toISOString();
  y.shows = shows.map((s) => s.number);
  y.savedAt = Date.now();
  all[YEAR] = y;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
  fs.renameSync(tmp, OUT);
  log('saved ' + path.relative(ROOT, OUT));
}

try { main(); } catch (e) { console.error(e.stack || String(e)); process.exit(1); }
