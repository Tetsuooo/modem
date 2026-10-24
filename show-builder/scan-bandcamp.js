// Scan Tetsuooo's Bandcamp wishlist + collection ("library"/purchases) for
// anything added in the last N days. Both are public, unauthenticated — the
// fancollection API just needs a fan_id, read once off the wishlist page's
// #pagedata blob (the same JSON blob that hydrates Bandcamp's own React UI).
const { curlGet, curlPostJson, cacheGet, cacheSet } = require('./lib');

const BC_USER = 'Tetsuooo';

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, '&');
}

function getFanId(force) {
  if (!force) {
    const cached = cacheGet('bc-fan-id');
    if (cached && cached.fanId) return cached.fanId;
  }
  const html = curlGet(`https://bandcamp.com/${BC_USER}/wishlist`);
  const m = html.match(/id="pagedata" data-blob="([^"]*)"/);
  if (!m) throw new Error('could not find #pagedata on the Bandcamp wishlist page — layout may have changed');
  const data = JSON.parse(decodeEntities(m[1]));
  const fanId = data.fan_data && data.fan_data.fan_id;
  if (!fanId) throw new Error('no fan_id in Bandcamp pagedata blob');
  cacheSet('bc-fan-id', { fanId, resolvedAt: new Date().toISOString() });
  return fanId;
}

function mapItem(item, sourceLabel) {
  const isAlbum = item.tralbum_type === 'a';
  return {
    source: sourceLabel,
    key: 'bc:' + item.tralbum_id,
    title: item.item_title,
    artist: item.band_name,
    url: item.item_url,
    artwork: item.item_art_url || null,
    date: item.added,
    albumId: isAlbum ? item.tralbum_id : null,
    trackId: isAlbum ? item.featured_track || null : item.tralbum_id,
    // Bandcamp's own label field — only some releases fill it (e.g. "Drag City Records");
    // the rest are found on the release page (labelFromPage(), in checkReleaseStatus())
    label: item.label || null,
  };
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

// The first `recordLabel` name anywhere in the page's structured data (ld+json):
// albumRelease[].recordLabel on an album page, under inAlbum on a track page.
function recordLabelOf(node, depth) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  if (node.recordLabel && node.recordLabel.name) return String(node.recordLabel.name).trim();
  for (const v of Object.values(node)) {
    const found = recordLabelOf(v, depth + 1);
    if (found) return found;
  }
  return null;
}

// A release's label, read off its own page (Matej, 2026-10-24: "you could be better at
// extracting the label info from bandcamp"):
//   1. Bandcamp's label field, when the release has one (structured data, recordLabel);
//   2. else the name of the page it's on, when that page isn't the artist's own — most
//      label releases sit on the label's page ("Artetetra", "mappa", "katharsis");
//   3. else none (the artist's own page: self-released).
// A page whose name is part of the artist's (or the other way round: "Sun Araw" vs
// "Sun Araw & M. Geddes Gengras") counts as the artist's own. Same idea as the Year-end
// list's accountIsLabel (year-end-releases.js).
function labelFromPage(html, artist) {
  const ld = html.match(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ld) {
    try {
      const found = recordLabelOf(JSON.parse(ld[1]), 0);
      if (found) return found;
    } catch (e) { /* no structured data */ }
  }
  const b = html.match(/data-band="([^"]*)"/);
  let page = '';
  try { page = (b && JSON.parse(decodeEntities(b[1])).name) || ''; } catch (e) { page = ''; }
  const p = norm(page), a = norm(artist);
  if (!p || !a || p === a || p.includes(a) || a.includes(p)) return null;
  return page.trim();
}

// For a track picked before the builder read labels (show-builder's /release-label).
function releaseLabel(url, artist) {
  const html = curlGet(url);
  const m = html.match(/data-tralbum="([^"]*)"/);
  let td = {};
  try { td = m ? JSON.parse(decodeEntities(m[1])) : {}; } catch (e) { td = {}; }
  return labelFromPage(html, td.artist || artist);
}

// Fetch the release's own page and read its data-tralbum blob (the same one
// Bandcamp's own player UI hydrates from) — gives us both (a) whether it's
// still a pre-order and how many tracks are streamable yet, and (b) for
// albums, the individual track list (id + own page URL) so the UI can offer
// picking specific tracks instead of downloading the whole release.
function checkReleaseStatus(item) {
  let html;
  try {
    html = curlGet(item.url);
  } catch (e) {
    return; // best-effort — leave the item unflagged rather than failing the scan
  }
  const m = html.match(/data-tralbum="([^"]*)"/);
  if (!m) return;
  let td;
  try {
    td = JSON.parse(decodeEntities(m[1]));
  } catch (e) {
    return;
  }
  const trackinfo = td.trackinfo || [];
  // Always capture the release date (not just for pre-orders) — the "older
  // than 3 months" age flag in the UI needs it for every item.
  item.releaseDate = td.album_release_date || (td.current && td.current.release_date) || null;
  if (!item.label) item.label = labelFromPage(html, td.artist || item.artist);
  item.labelChecked = true; // read off the page: the builder needn't look again (see /release-label)
  const preorder = !!(td.is_preorder || td.album_is_preorder);
  if (preorder) {
    item.preorder = true;
    item.tracksPublished = trackinfo.filter((t) => !t.unreleased_track && t.file).length;
    item.tracksTotal = trackinfo.length;
  }
  if (item.albumId) {
    item.tracks = trackinfo
      .filter((t) => !t.unreleased_track && t.file && t.title_link)
      .map((t) => ({
        id: t.track_id,
        title: t.title,
        // a compilation's tracks name their own artists (else the release's, in the page)
        artist: t.artist || null,
        url: new URL(t.title_link, item.url).href,
        duration: t.duration ? Math.round(t.duration) : null,
      }));
  } else {
    // A single-track item's own length — same trackinfo already parsed
    // above for the pre-order check, just reading one more field off it.
    item.duration = trackinfo[0] && trackinfo[0].duration ? Math.round(trackinfo[0].duration) : null;
  }
}

// endpoint: 'wishlist_items' | 'collection_items'
function fetchItems(endpoint, sourceLabel, fanId, cutoffDate) {
  const out = [];
  let olderThanToken = `${Math.floor(Date.now() / 1000)}:9999999999:a::`;
  let guard = 0;
  while (olderThanToken && guard < 50) {
    guard++;
    const body = curlPostJson(`https://bandcamp.com/api/fancollection/1/${endpoint}`, {
      fan_id: fanId,
      older_than_token: olderThanToken,
      count: 20,
    });
    const data = JSON.parse(body);
    if (data.error) throw new Error(`Bandcamp ${endpoint}: ${data.error_message}`);
    const items = data.items || [];
    if (!items.length) break;
    let hitOld = false;
    for (const item of items) {
      const added = new Date(item.added);
      if (added < cutoffDate) {
        hitOld = true;
        break;
      }
      out.push(mapItem(item, sourceLabel));
    }
    if (hitOld || !data.more_available) break;
    const last = items[items.length - 1];
    olderThanToken = last.token || null;
  }
  return out;
}

// Returns candidates shaped like:
// { source:'bandcamp-wishlist'|'bandcamp-library', key, title, artist, url, artwork, date, albumId, trackId,
//   preorder?, releaseDate?, tracksPublished?, tracksTotal?, tracks?: [{id,title,url,duration}] }
function scanWishlistAndLibrary(cutoffDate) {
  const fanId = getFanId(false);
  const wishlist = fetchItems('wishlist_items', 'bandcamp-wishlist', fanId, cutoffDate);
  const library = fetchItems('collection_items', 'bandcamp-library', fanId, cutoffDate);
  const items = [...wishlist, ...library];
  for (const item of items) checkReleaseStatus(item);
  return items;
}

// Resolves a track's own page to a directly-playable stream URL — same
// data-tralbum blob checkReleaseStatus already reads (trackinfo[].file is
// truthy only when the track is currently streamable), just pulling the
// actual mp3-128 url out instead of only checking presence. Used for the
// Scan tab's inline preview player, so it can use the same plain
// <audio>-based UI as a downloaded track instead of Bandcamp's own widget
// iframe per preview. `trackId` disambiguates on the rare page whose
// trackinfo covers more than this one track; falls back to the first entry.
function resolveStreamUrl(url, trackId) {
  const html = curlGet(url);
  const m = html.match(/data-tralbum="([^"]*)"/);
  if (!m) throw new Error('could not read Bandcamp track data');
  const td = JSON.parse(decodeEntities(m[1]));
  const trackinfo = td.trackinfo || [];
  let t = trackinfo[0];
  if (trackId != null && trackinfo.length > 1) {
    t = trackinfo.find((x) => x.track_id === trackId) || t;
  }
  const duration = t && t.duration ? Math.round(t.duration) : null;
  if (!t || !t.file) return { url: null, duration };
  const fileUrl = t.file['mp3-128'] || Object.values(t.file)[0];
  return { url: fileUrl || null, duration };
}

// Same page-fetch-and-parse as checkReleaseStatus()'s album branch, factored
// out standalone so a "Your show" entry that's a whole album picked before
// track metadata was cached (item.tracks missing entirely) can still be
// backfilled on demand — see /release-tracks in server.js and
// backfillItemDuration() in index.html.
function fetchAlbumTracks(item) {
  const html = curlGet(item.url);
  const m = html.match(/data-tralbum="([^"]*)"/);
  if (!m) return [];
  let td;
  try {
    td = JSON.parse(decodeEntities(m[1]));
  } catch (e) {
    return [];
  }
  const trackinfo = td.trackinfo || [];
  return trackinfo
    .filter((t) => !t.unreleased_track && t.file && t.title_link)
    .map((t) => ({
      id: t.track_id,
      title: t.title,
      url: new URL(t.title_link, item.url).href,
      duration: t.duration ? Math.round(t.duration) : null,
    }));
}

module.exports = { scanWishlistAndLibrary, getFanId, resolveStreamUrl, fetchAlbumTracks, releaseLabel, labelFromPage };
