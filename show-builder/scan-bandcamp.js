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
  };
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
        url: new URL(t.title_link, item.url).href,
        duration: t.duration ? Math.round(t.duration) : null,
      }));
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

module.exports = { scanWishlistAndLibrary, getFanId };
