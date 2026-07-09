#!/usr/bin/env node
/*
 * build-track-index.js — post-process src/assets/modem-archive.json into a flat,
 * TRACK/ALBUM-first index. For every Bandcamp/SoundCloud/YouTube embed in every
 * show it resolves the real title + artist + cover art (Bandcamp embed page's
 * `data-player-data`, SoundCloud/YouTube oEmbed), links it to the show(s) and
 * tracklist segment it appeared under, and dedupes across shows by a stable id
 * so each entry carries a "featured in modem NN" list.
 *
 * Network is cached in scripts/.cache (gitignored) and deduped by album/track id,
 * so re-runs are fast and polite. Metadata is best-effort: a failed lookup falls
 * back to the curator's tracklist label (title) and the show cover (art, in the UI).
 *
 * Usage:
 *   node scripts/build-track-index.js            # use cache where present
 *   node scripts/build-track-index.js --fresh    # ignore cache, re-fetch
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const CACHE_DIR = path.join(__dirname, '.cache');
const FRESH = process.argv.includes('--fresh');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
  if (!s) return s;
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Cached curl. Returns { body, live } or throws. Caches by key regardless of URL.
function curlCached(key, url, live) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, 'trk-' + key.replace(/[^\w.-]/g, '_'));
  if (!FRESH && fs.existsSync(cacheFile)) return { body: fs.readFileSync(cacheFile, 'utf8'), live: false };
  const body = execFileSync(
    'curl',
    ['-sS', '-L', '--compressed', '--max-time', '25', '-A', UA, '-H', 'Accept-Language: en;q=0.9', url],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  fs.writeFileSync(cacheFile, body);
  if (live) live.hit = true;
  return { body, live: true };
}

// ---- id extractors -------------------------------------------------------
function bandcampIds(src) {
  return {
    albumId: (src.match(/album=(\d+)/) || [])[1] || null,
    trackId: (src.match(/track=(\d+)/) || [])[1] || null,
  };
}
function soundcloudId(src) {
  const u = decodeURIComponent((src.match(/[?&]url=([^&]+)/) || [])[1] || '');
  return (u.match(/(\d{5,})/) || [])[1] || null;
}
function youtubeId(src) {
  return (
    (src.match(/[?&]v=([\w-]{6,})/) || [])[1] ||
    (src.match(/youtu\.be\/([\w-]{6,})/) || [])[1] ||
    (src.match(/embed\/([\w-]{6,})/) || [])[1] ||
    null
  );
}

// A Bandcamp release is a COMPILATION when the label/curator uploaded it under
// one name so every track's `artist` is that name and the real artist hides in
// the title as "Artist - Track". Detect it by an explicit V/A marker, or by all
// tracks sharing the album artist while their titles carry distinct "x - y"
// prefixes. When true, the caller lifts the real artist out of the title.
const DASH = / [-–—] /; // spaced hyphen / en-dash / em-dash used as "artist - title"
function isCompilation(pd) {
  const tracks = pd.tracks || [];
  if (tracks.length < 2) return false;
  const va = /(^|\W)(v\.?\s?a\.?|v\/a|various\s+artists?)(\W|$)/i;
  if (va.test(pd.artist || '') || va.test(pd.album_title || '')) return true;
  if (tracks.length < 4) return false;
  const alb = (pd.artist || '').trim();
  if (!alb) return false;
  if (!tracks.every((t) => (t.artist || alb).trim() === alb)) return false; // all credited to the label
  const dashed = tracks.filter((t) => DASH.test(t.title || ''));
  if (dashed.length < Math.ceil(tracks.length * 0.7)) return false;
  const firsts = new Set(dashed.map((t) => t.title.split(DASH)[0].trim().toLowerCase()));
  return firsts.size >= Math.ceil(dashed.length * 0.7) && !firsts.has(alb.toLowerCase()); // distinct real artists, none the label
}

// ---- resolvers (best-effort; return metadata or a bare {key}) ------------
function resolveBandcamp(src, live) {
  const { albumId, trackId } = bandcampIds(src);
  if (!albumId && !trackId) return null;
  const key = 'bc:' + (albumId || '-') + ':' + (trackId || '-');
  const url =
    'https://bandcamp.com/EmbeddedPlayer/' +
    (albumId ? 'album=' + albumId + '/' : '') +
    (trackId ? 'track=' + trackId + '/' : '');
  let pd;
  try {
    const { body } = curlCached('bc-' + (albumId || 't' + trackId), url, live);
    const m = body.match(/data-player-data="([^"]*)"/);
    pd = m ? JSON.parse(decodeEntities(m[1])) : null;
  } catch (e) {
    return { key, kind: 'bandcamp' };
  }
  if (!pd) return { key, kind: 'bandcamp' };
  const comp = isCompilation(pd);
  let title = pd.album_title || null;
  let artist = pd.artist || null;
  let artId = pd.album_art_id || null;
  let link = pd.linkback || pd.band_url || null;
  let duration = null;
  if (trackId) {
    const t = (pd.tracks || []).find((x) => String(x.id) === String(trackId));
    if (t) {
      title = t.title || title;
      artist = t.artist || artist;
      if (t.art_id) artId = t.art_id;
      if (t.title_link) link = t.title_link;
      if (t.duration) duration = Math.round(t.duration);
      // compilation: pull the real artist out of "Artist - Track"
      if (comp && DASH.test(title)) {
        const parts = title.split(DASH);
        const who = parts.shift().trim();
        const rest = parts.join(' - ').trim();
        if (who && rest) { artist = who; title = rest; }
      }
    }
  }
  return {
    key,
    kind: 'bandcamp',
    title,
    artist,
    artUrl: artId ? 'https://f4.bcbits.com/img/a' + artId + '_16.jpg' : null,
    link,
    duration,
    album: pd.album_title || null, // for a track embed this is the parent release
    albumUrl: pd.linkback && /\/album\//.test(pd.linkback) ? pd.linkback : null,
    comp: comp || undefined, // part of a compilation (real artist lifted from title)
  };
}

function resolveSoundcloud(src, live) {
  const id = soundcloudId(src);
  if (!id) return null;
  const key = 'sc:' + id;
  let j;
  try {
    const oembed =
      'https://soundcloud.com/oembed?format=json&url=' +
      encodeURIComponent('https://api.soundcloud.com/tracks/' + id);
    const { body } = curlCached('sc-' + id + '.json', oembed, live);
    j = JSON.parse(body);
  } catch (e) {
    return { key, kind: 'soundcloud' };
  }
  if (!j || !j.title) return { key, kind: 'soundcloud' };
  let title = j.title;
  const artist = j.author_name || null;
  if (artist && title.endsWith(' by ' + artist)) title = title.slice(0, -(' by ' + artist).length);
  let artUrl = j.thumbnail_url || null;
  if (artUrl && /placeholder/i.test(artUrl)) artUrl = null;
  // A track with no cover of its own displays the artist's profile avatar on
  // SoundCloud — mirror that by resolving the profile's oEmbed thumbnail.
  if (!artUrl && j.author_url) artUrl = soundcloudAvatar(j.author_url, live);
  return { key, kind: 'soundcloud', title: title || null, artist, artUrl, link: j.author_url || null };
}

const _avatarCache = {};
function soundcloudAvatar(profileUrl, live) {
  if (profileUrl in _avatarCache) return _avatarCache[profileUrl];
  let out = null;
  try {
    const oembed = 'https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(profileUrl);
    const cacheKey = 'scav-' + profileUrl.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '_') + '.json';
    const { body } = curlCached(cacheKey, oembed, live);
    const j = JSON.parse(body);
    const t = j && j.thumbnail_url;
    if (t && !/placeholder/i.test(t)) out = t;
  } catch (e) { out = null; }
  _avatarCache[profileUrl] = out;
  return out;
}

function resolveYoutube(src, live) {
  const id = youtubeId(src);
  if (!id) return null;
  const key = 'yt:' + id;
  try {
    const oembed =
      'https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    const { body } = curlCached('yt-' + id + '.json', oembed, live);
    const j = JSON.parse(body);
    return {
      key,
      kind: 'youtube',
      title: j.title || null,
      artist: j.author_name || null,
      artUrl: j.thumbnail_url || null,
      link: 'https://www.youtube.com/watch?v=' + id,
    };
  } catch (e) {
    return { key, kind: 'youtube' };
  }
}

function kindOf(src) {
  if (/bandcamp\.com/i.test(src)) return 'bandcamp';
  if (/soundcloud\.com/i.test(src)) return 'soundcloud';
  if (/youtube\.com|youtu\.be/i.test(src)) return 'youtube';
  return null;
}

// Walk a show's bodyHtml in document order, tracking the current tracklist
// segment, and yield each embed iframe with the segment it sits under.
function embedsWithSegments(bodyHtml) {
  const out = [];
  const re = /<p\b[^>]*data-seg="(\d+)"|<iframe\b[^>]+src="([^"]+)"/gi;
  let m;
  let curSeg = null;
  while ((m = re.exec(bodyHtml))) {
    if (m[1] != null) curSeg = Number(m[1]);
    else out.push({ src: decodeEntities(m[2]), seg: curSeg });
  }
  return out;
}

// ---- main ----------------------------------------------------------------
(async () => {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const index = new Map(); // key → track entry
  let liveHits = 0;
  let processed = 0;

  for (const rec of data.records) {
    const segLabels = rec.segments || [];
    for (const { src, seg } of embedsWithSegments(rec.bodyHtml || '')) {
      const kind = kindOf(src);
      if (!kind) continue;
      processed++;
      const live = { hit: false };
      let meta =
        kind === 'bandcamp' ? resolveBandcamp(src, live)
        : kind === 'soundcloud' ? resolveSoundcloud(src, live)
        : resolveYoutube(src, live);
      if (!meta) meta = { key: kind + ':' + src, kind };
      if (live.hit) {
        liveHits++;
        await sleep(450); // be polite on real fetches only
      }

      const segLabel = seg != null && segLabels[seg] != null ? segLabels[seg] : null;
      // Labels that belong to THIS specific track: the show's label tags whose
      // heading sits at this embed's segment. A label released one track (or a
      // few, for a compilation) in the show — not the whole show — so we place it
      // by segment. A label the scraper couldn't tie to a heading (seg == null) is
      // deliberately attached to NOTHING: better to under-match than to wrongly
      // tag every track (which is the bug this replaces). The unsegmented year-end
      // "best of" lists carry 30+ distinct labels with no per-album structure, so
      // their label chips stay unresolved until a dedicated per-album sweep.
      const recLabels = rec.labels || [];
      const labels = seg != null ? recLabels.filter((l) => l.seg === seg).map((l) => l.name) : [];
      const appearance = {
        number: rec.number,
        slug: rec.slug,
        date: rec.date,
        type: rec.type,
        seg,
        segLabel,
        labels,
      };

      let entry = index.get(meta.key);
      if (!entry) {
        entry = {
          key: meta.key,
          kind: meta.kind || kind,
          title: meta.title || null,
          artist: meta.artist || null,
          artUrl: meta.artUrl || null,
          link: meta.link || null,
          duration: meta.duration || null,
          album: meta.album || null,
          albumUrl: meta.albumUrl || null,
          comp: meta.comp || undefined,
          embedSrc: src,
          shows: [],
        };
        index.set(meta.key, entry);
      } else {
        // fill any gaps a later, richer resolution provides
        entry.title = entry.title || meta.title || null;
        entry.artist = entry.artist || meta.artist || null;
        entry.artUrl = entry.artUrl || meta.artUrl || null;
        entry.link = entry.link || meta.link || null;
        entry.duration = entry.duration || meta.duration || null;
        entry.album = entry.album || meta.album || null;
        entry.albumUrl = entry.albumUrl || meta.albumUrl || null;
        if (meta.comp) entry.comp = true;
      }
      // avoid listing the same show twice for one track
      if (!entry.shows.some((s) => s.slug === rec.slug && s.seg === seg)) entry.shows.push(appearance);

      if (processed % 25 === 0) console.log('  … ' + processed + ' embeds, ' + liveHits + ' live');
    }
  }

  const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Drop dead/unresolvable embeds: a track the provider never resolved has no
  // artist, no artwork and no source link (e.g. the SoundCloud/Bandcamp track was
  // deleted → oEmbed 404). These would otherwise show as just the tracklist label
  // with the show's cover and nothing to play, so they don't belong in the index.
  const all = [...index.values()];
  const dropped = all.filter((t) => !t.artist && !t.artUrl && !t.link);
  const tracks = all.filter((t) => t.artist || t.artUrl || t.link).map((t) => {
    // fall back to the curator's tracklist label when a real title is missing
    if (!t.title) {
      const s = t.shows.find((x) => x.segLabel);
      t.title = s ? s.segLabel : null;
    }
    const nums = t.shows.map((s) => s.number).filter((n) => n != null);
    t.searchText = [
      t.title,
      t.artist,
      ...t.shows.map((s) => s.segLabel),
      ...nums.map((n) => 'modem ' + n),
      ...nums.map((n) => '' + n),
    ]
      .filter(Boolean)
      .join(' \n ');
    return t;
  });
  if (dropped.length) console.log('  dropped ' + dropped.length + ' unresolvable embeds: ' + dropped.map((t) => t.key).join(', '));

  // stable, readable order: by artist then title (locale-aware, symbols last)
  tracks.sort((a, b) => {
    const aa = norm(a.artist) || '￿';
    const bb = norm(b.artist) || '￿';
    return aa.localeCompare(bb) || norm(a.title).localeCompare(norm(b.title));
  });

  data.tracks = tracks;
  data.counts = data.counts || {};
  data.counts.tracks = tracks.length;
  data.tracksGeneratedAt = data.generatedAt; // stamp reuse (no Date.now needed here)
  delete data.tracksStale; // fresh index — clear the scraper's "carried-forward" flag

  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));

  const withTitle = tracks.filter((t) => t.title).length;
  const withArt = tracks.filter((t) => t.artUrl).length;
  const withArtist = tracks.filter((t) => t.artist).length;
  console.log(
    '\nWrote ' + tracks.length + ' unique tracks (' + withTitle + ' titled, ' +
      withArtist + ' with artist, ' + withArt + ' with art) from ' + processed +
      ' embeds, ' + liveHits + ' live fetches → ' + path.relative(ROOT, FILE)
  );
})();
