/*
 * sc-search.js — the SoundCloud-lookup half of find-sc-matches.js, as a module so
 * two callers share ONE implementation:
 *   • scripts/find-sc-matches.js  — the batch pass over every Bandcamp track
 *   • show-builder/sc-links.js    — on-demand search for a single track (the
 *                                   "SoundCloud link" picker in Your show, and
 *                                   the SoundCloud-links tab's own search box)
 *
 * SoundCloud's public API is closed, so we lift a `client_id` from their web JS
 * bundle and query the internal api-v2 endpoints. Everything is cached in
 * scripts/.cache (shared with the batch script, so a track searched here is free
 * the next time the batch pass or publish pipeline needs it) and callers are
 * expected to rate-limit themselves when they loop.
 *
 * Nothing in here touches the archive data.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const CACHE_DIR = path.join(__dirname, '.cache');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function curl(url) {
  return execFileSync('curl', ['-sS', '-L', '--compressed', '--max-time', '25', '-A', UA, url], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

// Cached GET (returns body string; empty on failure). `live` is an optional
// { hit } object flipped to true whenever the network was actually used, so a
// batch caller knows when to pause. An empty body is a failed fetch — it is
// neither trusted from the cache nor written to it, so a one-off network blip
// is retried next time instead of being remembered as "no results" forever.
function cachedGet(key, url, live, fresh) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cf = path.join(CACHE_DIR, key.replace(/[^\w.-]/g, '_'));
  if (!fresh && fs.existsSync(cf) && fs.statSync(cf).size > 0) return fs.readFileSync(cf, 'utf8');
  let body = '';
  try { body = curl(url); } catch (e) { body = ''; }
  if (body) fs.writeFileSync(cf, body);
  if (live) live.hit = true;
  return body;
}

// The SoundCloud account (artist OR label) linked on a Bandcamp release page.
const NON_ACCOUNT = /^(pages|discover|stream|search|you|upload|settings|tags|people|charts|mobile|imprint|popular|terms|jobs|help)$/i;
function bcPage(bcLink, live, fresh) {
  return cachedGet('bcpage-' + bcLink.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '_') + '.html', bcLink, live, fresh);
}
function bandcampScHandle(bcLink, live, fresh) {
  if (!bcLink) return null;
  const html = bcPage(bcLink, live, fresh);
  for (const raw of html.match(/soundcloud\.com\/([A-Za-z0-9_-]+)/g) || []) {
    const h = raw.split('/')[1];
    if (h && !NON_ACCOUNT.test(h)) return h;
  }
  return null;
}
// The Bandcamp account/label a release lives on (og:site_name), e.g. a label for
// "various artists" comps. Reads the same cached page as bandcampScHandle.
function bandcampLabel(bcLink, live, fresh) {
  if (!bcLink) return null;
  const html = bcPage(bcLink, live, fresh);
  const m = html.match(/<meta property="og:site_name" content="([^"]+)"/i);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#0*39;/g, "'").replace(/&quot;/g, '"').replace(/&#x27;/gi, "'").trim() : null;
}

// shape an api-v2 track into our candidate object (dropping SNIP/30s previews).
function toCand(t, canonical) {
  if (!t || !t.id) return null;
  const snip = t.policy === 'SNIP' || (t.full_duration && t.duration && t.full_duration - t.duration > 5000);
  if (snip) return null; // 30s previews can't be used → never surface them
  return {
    id: t.id, title: t.title || '', user: (t.user && t.user.username) || '',
    permalink: t.permalink_url || '', duration: Math.round((t.full_duration || t.duration || 0) / 1000),
    artwork: t.artwork_url || (t.user && t.user.avatar_url) || '', canonical: !!canonical,
  };
}

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');

// Confidence: exact artist + exact title = 6 (auto-suggestable); partials score lower.
function score(bc, cand) {
  const na = norm(bc.artist), nt = norm(bc.title);
  const ca = norm(cand.user), ct = norm(cand.title);
  let s = 0;
  if (na && ca) s += na === ca ? 3 : (ca.includes(na) || na.includes(ca) ? 1.5 : 0);
  if (nt && ct) s += nt === ct ? 3 : (ct.includes(nt) || nt.includes(ct) ? 1.5 : 0);
  // label / compilation uploads often bury the artist in the title ("Artist - Title")
  if (na && ct && na.length > 2 && ct.includes(na)) s += 1.5;
  // uploaded by the artist/label's own account (linked on the Bandcamp page)
  if (cand.canonical) s += 2;
  return s;
}

// Searcher bound to one client_id. `fresh` re-fetches everything (the batch
// script's --fresh); the client_id itself is cached on disk between runs.
function createSearcher({ fresh = false } = {}) {
  const uidCache = {}, utracksCache = {};
  let cid = null;

  // Extract (and cache) a working client_id from SoundCloud's web JS bundles.
  function getClientId(force) {
    const cf = path.join(CACHE_DIR, 'sc_client_id.txt');
    if (!force && !fresh && fs.existsSync(cf)) {
      const v = fs.readFileSync(cf, 'utf8').trim();
      if (v) return v;
    }
    const home = curl('https://soundcloud.com/');
    const bundles = [...new Set(home.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[0-9a-f-]+\.js/g) || [])];
    for (const b of bundles) {
      let js;
      try { js = curl(b); } catch (e) { continue; }
      const m = js.match(/client_id[:=]"([A-Za-z0-9]{20,})"/);
      if (m) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cf, m[1]);
        return m[1];
      }
    }
    throw new Error('could not extract a SoundCloud client_id from the web bundles');
  }
  const clientId = () => (cid = cid || getClientId(false));

  function scUserId(handle, live) {
    if (handle in uidCache) return uidCache[handle];
    let id = null;
    const body = cachedGet('scuser-' + handle + '.json',
      'https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent('https://soundcloud.com/' + handle) + '&client_id=' + clientId(), live, fresh);
    try { const j = JSON.parse(body); if (j && j.kind === 'user' && j.id) id = j.id; } catch (e) {}
    return (uidCache[handle] = id);
  }
  function scUserTracks(userId, live) {
    if (userId in utracksCache) return utracksCache[userId];
    let tracks = [];
    const body = cachedGet('sctracks-' + userId + '.json',
      'https://api-v2.soundcloud.com/users/' + userId + '/tracks?client_id=' + clientId() + '&limit=200', live, fresh);
    try { tracks = JSON.parse(body).collection || []; } catch (e) {}
    return (utracksCache[userId] = tracks);
  }

  // A search call that survives a rotated client_id: SoundCloud answers a stale
  // one with a 401/403 body that isn't a track collection. Refresh the id once
  // and retry, dropping the bad cache entry rather than keeping it.
  function searchBody(cacheKey, q, limit, live) {
    const make = () => 'https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(q) + '&client_id=' + clientId() + '&limit=' + limit;
    let body = cachedGet(cacheKey, make(), live, fresh);
    let ok = false;
    try { ok = Array.isArray(JSON.parse(body).collection); } catch (e) {}
    if (!ok) {
      try { fs.unlinkSync(path.join(CACHE_DIR, cacheKey.replace(/[^\w.-]/g, '_'))); } catch (e) {}
      cid = getClientId(true);
      body = cachedGet(cacheKey, make(), live, true);
    }
    return body;
  }

  function parseCollection(body) {
    let coll = [];
    try { coll = JSON.parse(body).collection || []; } catch (e) { coll = []; }
    return coll.filter((t) => t && t.kind !== 'playlist' && t.streamable !== false).map((t) => toCand(t, false)).filter(Boolean);
  }

  // Ranked SoundCloud candidates for one Bandcamp track.
  //   bc = { key, artist, title, link, duration }
  // Returns { candidates (top 5, scored), tier: 'auto'|'review'|'none',
  //           suggest: id|null, bcLabel }
  function findCandidates(bc, live) {
    const q = [bc.artist, bc.title].filter(Boolean).join(' ').trim();

    // (a) global SoundCloud search by artist + title
    let cands = parseCollection(searchBody('scq-' + bc.key.replace(/[^\w.-]/g, '_') + '.json', q, 6, live));

    // (b) the SoundCloud account (artist OR label) linked on the Bandcamp page —
    // title-match inside it; catches label uploads the global search misses.
    const handle = bandcampScHandle(bc.link, live, fresh);
    const bcLabel = bandcampLabel(bc.link, live, fresh);
    if (handle) {
      const uid = scUserId(handle, live);
      if (uid) {
        const nt = norm(bc.title);
        for (const t of scUserTracks(uid, live)) {
          const c = toCand(t, true);
          if (c && nt) { const ct = norm(c.title); if (ct === nt || ct.includes(nt) || nt.includes(ct)) cands.push(c); }
        }
      }
    }

    // dedupe by id (an account track may repeat a global hit), keep canonical flag
    const seen = {};
    cands = cands.filter((c) => { if (seen[c.id]) { if (c.canonical) seen[c.id].canonical = true; return false; } seen[c.id] = c; return true; });
    cands.forEach((c) => (c.score = score(bc, c)));
    cands.sort((a, b) => b.score - a.score);

    // auto = exact title + duration, from the exact artist OR the artist/label's
    // own (canonical) SoundCloud account; review = plausible; none = nothing good.
    const top = cands[0];
    const durOk = top && bc.duration && top.duration && Math.abs(bc.duration - top.duration) <= 4;
    const titleExact = top && norm(top.title) === norm(bc.title);
    const artistExact = top && norm(top.user) === norm(bc.artist);
    let tier = 'none';
    if (top) tier = (titleExact && durOk && (artistExact || top.canonical)) ? 'auto' : (top.score >= 3 ? 'review' : 'none');
    return { candidates: cands.slice(0, 5), tier, suggest: tier === 'auto' ? top.id : null, bcLabel: bcLabel || '' };
  }

  // Free-text track search (the "search soundcloud" box). `ref` is optional
  // { artist, title } to rank the hits against the Bandcamp track being linked.
  function searchText(q, ref, live) {
    const key = 'scq-free-' + crypto.createHash('sha1').update(q).digest('hex').slice(0, 16) + '.json';
    const cands = parseCollection(searchBody(key, q, 10, live));
    if (ref) cands.forEach((c) => (c.score = score(ref, c)));
    if (ref) cands.sort((a, b) => b.score - a.score);
    return cands;
  }

  return { getClientId: clientId, findCandidates, searchText };
}

module.exports = { createSearcher, norm, score, toCand, cachedGet, CACHE_DIR };
