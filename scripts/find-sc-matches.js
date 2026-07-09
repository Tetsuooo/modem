#!/usr/bin/env node
/*
 * find-sc-matches.js — assistive pass: for every Bandcamp track in
 * modem-archive.json, search SoundCloud for the same upload and record ranked
 * candidate matches for MANUAL review (see sc-match-review.html → apply-sc-matches.js).
 *
 * SoundCloud's public API is closed, so we lift a `client_id` from their web JS
 * bundle and query the internal api-v2 search endpoint. Everything is cached in
 * scripts/.cache and rate-limited, so re-runs are fast and polite.
 *
 * Nothing here touches the archive data — it only writes scripts/sc-match-candidates.json.
 *
 * Usage:
 *   node scripts/find-sc-matches.js            # use cache where present
 *   node scripts/find-sc-matches.js --fresh    # re-fetch client_id + all searches
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const OUT_FILE = path.join(__dirname, 'sc-match-candidates.json');
const CACHE_DIR = path.join(__dirname, '.cache');
const FRESH = process.argv.includes('--fresh');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function curl(url) {
  return execFileSync('curl', ['-sS', '-L', '--compressed', '--max-time', '25', '-A', UA, url], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
}

// Cached GET (returns body string; empty on failure).
function cachedGet(key, url, live) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cf = path.join(CACHE_DIR, key.replace(/[^\w.-]/g, '_'));
  if (!FRESH && fs.existsSync(cf)) return fs.readFileSync(cf, 'utf8');
  let body = '';
  try { body = curl(url); } catch (e) { body = ''; }
  fs.writeFileSync(cf, body);
  if (live) live.hit = true;
  return body;
}

// The SoundCloud account (artist OR label) linked on a Bandcamp release page.
const NON_ACCOUNT = /^(pages|discover|stream|search|you|upload|settings|tags|people|charts|mobile|imprint|popular|terms|jobs|help)$/i;
function bandcampScHandle(bcLink, live) {
  if (!bcLink) return null;
  const html = cachedGet('bcpage-' + bcLink.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '_') + '.html', bcLink, live);
  for (const raw of html.match(/soundcloud\.com\/([A-Za-z0-9_-]+)/g) || []) {
    const h = raw.split('/')[1];
    if (h && !NON_ACCOUNT.test(h)) return h;
  }
  return null;
}
// The Bandcamp account/label a release lives on (og:site_name), e.g. a label for
// "various artists" comps. Reads the same cached page as bandcampScHandle.
function bandcampLabel(bcLink, live) {
  if (!bcLink) return null;
  const html = cachedGet('bcpage-' + bcLink.replace(/^https?:\/\//, '').replace(/[^\w.-]/g, '_') + '.html', bcLink, live);
  const m = html.match(/<meta property="og:site_name" content="([^"]+)"/i);
  return m ? m[1].replace(/&amp;/g, '&').replace(/&#0*39;/g, "'").replace(/&quot;/g, '"').replace(/&#x27;/gi, "'").trim() : null;
}
const _uid = {}, _utracks = {};
function scUserId(handle, cid, live) {
  if (handle in _uid) return _uid[handle];
  let id = null;
  const body = cachedGet('scuser-' + handle + '.json',
    'https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent('https://soundcloud.com/' + handle) + '&client_id=' + cid, live);
  try { const j = JSON.parse(body); if (j && j.kind === 'user' && j.id) id = j.id; } catch (e) {}
  return (_uid[handle] = id);
}
function scUserTracks(userId, cid, live) {
  if (userId in _utracks) return _utracks[userId];
  let tracks = [];
  const body = cachedGet('sctracks-' + userId + '.json',
    'https://api-v2.soundcloud.com/users/' + userId + '/tracks?client_id=' + cid + '&limit=200', live);
  try { tracks = JSON.parse(body).collection || []; } catch (e) {}
  return (_utracks[userId] = tracks);
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

// Extract (and cache) a working client_id from SoundCloud's web JS bundles.
function getClientId() {
  const cf = path.join(CACHE_DIR, 'sc_client_id.txt');
  if (!FRESH && fs.existsSync(cf)) {
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

(async () => {
  const cid = getClientId();
  console.log('SoundCloud client_id: ' + cid.slice(0, 6) + '…');

  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  // Only tracks actually played in a radio SHOW — skip the year-end "best
  // releases" list embeds, which are whole albums, not individual show tracks.
  const inShow = (t) => (t.shows || []).some((s) => s.type === 'show');
  const bandcamp = (data.tracks || []).filter((t) => t.kind === 'bandcamp' && inShow(t));
  console.log('bandcamp show tracks to match: ' + bandcamp.length);

  const out = [];
  let i = 0, live = 0;
  for (const bc of bandcamp) {
    i++;
    const L = { hit: false };
    const q = [bc.artist, bc.title].filter(Boolean).join(' ').trim();

    // (a) global SoundCloud search by artist + title
    const body = cachedGet('scq-' + bc.key.replace(/[^\w.-]/g, '_') + '.json',
      'https://api-v2.soundcloud.com/search/tracks?q=' + encodeURIComponent(q) + '&client_id=' + cid + '&limit=6', L);
    let coll = [];
    try { coll = JSON.parse(body).collection || []; } catch (e) { coll = []; }
    let cands = coll.filter((t) => t && t.kind !== 'playlist' && t.streamable !== false).map((t) => toCand(t, false)).filter(Boolean);

    // (b) the SoundCloud account (artist OR label) linked on the Bandcamp page —
    // title-match inside it; catches label uploads the global search misses.
    const handle = bandcampScHandle(bc.link, L);
    const bcLabel = bandcampLabel(bc.link, L);
    if (handle) {
      const uid = scUserId(handle, cid, L);
      if (uid) {
        const nt = norm(bc.title);
        for (const t of scUserTracks(uid, cid, L)) {
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
    if (L.hit) { live++; await sleep(600); }

    // auto = exact title + duration, from the exact artist OR the artist/label's
    // own (canonical) SoundCloud account; review = plausible; none = nothing good.
    const top = cands[0];
    const durOk = top && bc.duration && top.duration && Math.abs(bc.duration - top.duration) <= 4;
    const titleExact = top && norm(top.title) === norm(bc.title);
    const artistExact = top && norm(top.user) === norm(bc.artist);
    let tier = 'none';
    if (top) tier = (titleExact && durOk && (artistExact || top.canonical)) ? 'auto' : (top.score >= 3 ? 'review' : 'none');

    out.push({
      key: bc.key, bcTitle: bc.title || '', bcArtist: bc.artist || '', bcArt: bc.artUrl || '',
      bcLink: bc.link || '', bcEmbed: bc.embedSrc || '', bcDuration: bc.duration || null, bcLabel: bcLabel || '',
      shows: (bc.shows || []).map((s) => s.number).filter((n) => n != null),
      candidates: cands.slice(0, 5), tier, suggest: tier === 'auto' ? top.id : null,
    });
    if (i % 20 === 0) console.log('  … ' + i + '/' + bandcamp.length + ' (' + live + ' live)');
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  const t = (name) => out.filter((o) => o.tier === name).length;
  console.log(
    '\nWrote ' + out.length + ' bandcamp tracks → ' + path.relative(ROOT, OUT_FILE) +
      ' (' + live + ' live searches)\n' +
      '  auto-accept (exact + duration): ' + t('auto') + '\n' +
      '  needs review: ' + t('review') + '\n' +
      '  no match (stays Bandcamp): ' + t('none')
  );
})();
