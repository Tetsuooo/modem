// Scan modemodemodem's SoundCloud reposts feed for anything reposted in the
// last N days. SoundCloud's api-v2 (undocumented, used by their own web app)
// needs a client_id — there's no way to get one "properly" for this use case,
// so it's scraped out of SoundCloud's own JS bundles, same trick every
// third-party SoundCloud tool uses. Cached (it's stable for weeks/months),
// re-derived automatically if a request comes back 401.
const { execFileSync } = require('child_process');
const { UA, cacheGet, cacheSet } = require('./lib');

const SC_USER = 'modemodemodem';

function curlStatus(url, extraHeaders) {
  const headers = Object.assign({ 'Accept-Language': 'en-us,en;q=0.9' }, extraHeaders || {});
  const args = ['-sS', '-L', '--compressed', '--max-time', '25', '-A', UA];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push('-w', '\n%{http_code}', url);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const i = out.lastIndexOf('\n');
  return { body: out.slice(0, i), status: Number(out.slice(i + 1)) };
}

function deriveClientId() {
  const home = execFileSync('curl', ['-sS', '-L', '--compressed', '--max-time', '25', '-A', UA, 'https://soundcloud.com'], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
  const bundles = [...home.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  for (const url of bundles) {
    let js;
    try {
      js = execFileSync('curl', ['-sS', '--max-time', '20', '-A', UA, url], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
    } catch (e) {
      continue;
    }
    const m = js.match(/client_id:"([a-zA-Z0-9]{32})"/);
    if (m) return m[1];
  }
  throw new Error('could not find a SoundCloud client_id in any JS bundle — SoundCloud may have changed their bundling');
}

function getClientId(force) {
  if (!force) {
    const cached = cacheGet('sc-client-id');
    if (cached && cached.clientId) return cached.clientId;
  }
  const clientId = deriveClientId();
  cacheSet('sc-client-id', { clientId, derivedAt: new Date().toISOString() });
  return clientId;
}

// GET an api-v2.soundcloud.com URL, transparently re-deriving client_id once
// on a 401 (SoundCloud rotates these periodically).
function apiV2Get(url, clientId) {
  const sep = url.includes('?') ? '&' : '?';
  let { body, status } = curlStatus(url + sep + 'client_id=' + clientId);
  if (status === 401) {
    clientId = getClientId(true);
    ({ body, status } = curlStatus(url + sep + 'client_id=' + clientId));
  }
  if (status >= 400) throw new Error(`SoundCloud api-v2 ${status}: ${url}`);
  return { data: JSON.parse(body), clientId };
}

function resolveUserId(clientId) {
  const { data } = apiV2Get(
    'https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent('https://soundcloud.com/' + SC_USER),
    clientId
  );
  if (!data || data.kind !== 'user') throw new Error('could not resolve SoundCloud user ' + SC_USER);
  return data.id;
}

// Returns candidates shaped like:
// { source:'soundcloud', key, title, artist, url, artwork, date, releaseDate, isPlaylist, trackCount }
// `date` is when it was reposted; `releaseDate` is the track's own SoundCloud
// upload/release date (release_date if the artist set one, else created_at) —
// what the "older than 3 months" age flag in the UI keys off.
function scanReposts(cutoffDate) {
  let clientId = getClientId(false);
  const userId = resolveUserId(clientId);

  const out = [];
  let url = `https://api-v2.soundcloud.com/stream/users/${userId}/reposts?limit=50`;
  let guard = 0;
  while (url && guard < 20) {
    guard++;
    const { data, clientId: cid } = apiV2Get(url, clientId);
    clientId = cid;
    const items = data.collection || [];
    let hitOld = false;
    for (const item of items) {
      const createdAt = new Date(item.created_at);
      if (createdAt < cutoffDate) {
        hitOld = true;
        break;
      }
      const isPlaylist = item.type === 'playlist-repost';
      const track = isPlaylist ? item.playlist : item.track;
      if (!track) continue;
      out.push({
        source: 'soundcloud',
        key: 'sc:' + track.id,
        title: track.title,
        artist: (track.user && track.user.username) || item.user?.username || 'unknown',
        url: track.permalink_url,
        artwork: track.artwork_url || (track.user && track.user.avatar_url) || null,
        date: item.created_at,
        // SoundCloud's own `display_date` is what it actually shows publicly
        // as the upload/publish date — NOT simply release_date||created_at:
        // a track's created_at can predate when it was actually made public
        // (e.g. re-published/rescheduled after being private), in which case
        // display_date jumps forward to the real publish date and created_at
        // stays stuck in the past. Confirmed against live data: a track
        // "published 3 days ago" had created_at over a year old, but
        // display_date matched the real 3-day-old publish date exactly.
        releaseDate: track.display_date || track.release_date || track.created_at || null,
        isPlaylist,
        trackCount: isPlaylist ? (track.track_count || (track.tracks || []).length || null) : null,
      });
    }
    if (hitOld || !items.length) break;
    url = data.next_href || null;
  }
  return out;
}

// A playlist repost's embedded track list is often truncated by SoundCloud
// to a handful of "full" objects plus bare {id,kind:"track"} stubs for the
// rest — re-resolving the playlist directly gives the same split, so stub
// ids are batch-resolved via api-v2's /tracks?ids= (used by SoundCloud's own
// web app for exactly this). Called lazily (only when a playlist row is
// expanded in the UI), not during scanReposts, to keep the scan itself fast.
function resolveTracks(item) {
  let clientId = getClientId(false);
  const { data, clientId: cid } = apiV2Get(
    'https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent(item.url),
    clientId
  );
  clientId = cid;
  if (!data || data.kind !== 'playlist') throw new Error('not a SoundCloud playlist: ' + item.url);
  const rawTracks = data.tracks || [];
  const stubs = rawTracks.filter((t) => !t.permalink_url);
  let resolvedFull = [];
  if (stubs.length) {
    const ids = stubs.map((t) => t.id).join(',');
    const { data: batch } = apiV2Get('https://api-v2.soundcloud.com/tracks?ids=' + ids, clientId);
    resolvedFull = Array.isArray(batch) ? batch : [];
  }
  const byId = new Map([...rawTracks.filter((t) => t.permalink_url), ...resolvedFull].map((t) => [t.id, t]));
  return rawTracks
    .map((t) => byId.get(t.id))
    .filter(Boolean)
    .map((t) => ({
      id: t.id,
      title: t.title,
      artist: (t.user && t.user.username) || null,
      url: t.permalink_url,
      artwork: t.artwork_url || null,
      duration: t.duration ? Math.round(t.duration / 1000) : null,
      // The playlist's own releaseDate is just when it was assembled, not
      // when this track was published — each resolved track needs its own.
      // display_date (see scanReposts' comment above) over release_date/
      // created_at: it's what SoundCloud itself shows as the publish date.
      releaseDate: t.display_date || t.release_date || t.created_at || null,
    }));
}

module.exports = { scanReposts, getClientId, resolveTracks };
