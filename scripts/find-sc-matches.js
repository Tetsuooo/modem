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
const { createSearcher } = require('./sc-search');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const OUT_FILE = path.join(__dirname, 'sc-match-candidates.json');
const FRESH = process.argv.includes('--fresh');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The SoundCloud lookups themselves (client_id, search, account scan, scoring,
// tiering) live in ./sc-search.js — shared with the show builder's on-demand
// "SoundCloud link" picker, so both always rank candidates the same way.
(async () => {
  const searcher = createSearcher({ fresh: FRESH });
  const cid = searcher.getClientId();
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
    const r = searcher.findCandidates(bc, L);
    if (L.hit) { live++; await sleep(600); }

    out.push({
      key: bc.key, bcTitle: bc.title || '', bcArtist: bc.artist || '', bcArt: bc.artUrl || '',
      bcLink: bc.link || '', bcEmbed: bc.embedSrc || '', bcDuration: bc.duration || null, bcLabel: r.bcLabel,
      shows: (bc.shows || []).map((s) => s.number).filter((n) => n != null),
      candidates: r.candidates, tier: r.tier, suggest: r.suggest,
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
