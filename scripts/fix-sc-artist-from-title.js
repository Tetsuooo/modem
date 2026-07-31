#!/usr/bin/env node
/*
 * fix-sc-artist-from-title.js — a SoundCloud-only track's `artist` field is
 * sometimes just the uploading label/collective's own account name (they
 * posted the track themselves, e.g. Baba Vanga's own SoundCloud reposting
 * an artist's track) — SoundCloud's own metadata names the UPLOADER, not
 * the artist, and the real artist only survives as free text baked into the
 * track's own title (e.g. "Daniel Kordik - Vločky (upcoming on Baba
 * Vanga)", artist scraped as "Baba Vanga").
 *
 * Only the unambiguous "Artist - Title" / "Artist — Title" shape (real
 * whitespace on both sides of the dash, so an artist name that itself
 * contains a bare hyphen — e.g. "0-N0" — isn't mis-split) is recovered
 * automatically. Every other shape seen in the archive — "Artist, 'Title'
 * (2021). Courtesy the artist.", "'Title' by Artist for Label",
 * catalog-number-prefixed ("GPDF265 : Artist : \"Title\""), or titles with
 * no artist in them at all — is too varied to guess safely and is left
 * alone, reported back as `unresolved` for manual review instead.
 *
 * Run AFTER tagEdits in apply-overrides.js (not before) — a handful of
 * irregular-shaped titles (comma-delimited, colon-delimited, "'Title' by
 * Artist for Label", etc.) got their artist recovered by hand via a tagEdits
 * "artist" override instead of this heuristic; running after means this
 * function sees that already-fixed artist and correctly leaves them alone,
 * rather than re-flagging already-resolved tracks as unresolved forever.
 *
 * Applied in apply-overrides.js so it survives --reparse.
 */
// Reviewed once and confirmed the label/collective genuinely IS the credited
// artist (no separate artist hides in the title) — skip these permanently so
// future review runs only ever surface genuinely NEW unresolved tracks, not
// the same already-decided ones every time. Same idea as approvals.json's
// "null = reviewed, no match" for SoundCloud matches.
const CONFIRMED_LABEL_IS_ARTIST = new Set([
  'sc:647325975',  // modem-65  BICCO BEAT · Telephone
  'sc:1564943212', // modem-168 childsplay · ☾ mala roza muca ♡ nyul<v3 ft. pixel.bambi ☽
  'sc:981610942',  // modem-106 ity · [looking at planet-ok]0217a
  'sc:982589056',  // modem-106 juramento · Diablito
  'sc:982961872',  // modem-106 MOAT GLOW · PLUCK
  'sc:389789568',  // modem-106 soda · memory upload
  'sc:1914389021', // modem-202 mykesrhiza · B4 Motion Sound Picture
  'sc:552929058',  // modem-56  R's Demento · Rose Of Wreckage feat City
  'sc:1837627845', // modem-190 smile gang · smile television 2024
  'sc:563888727',  // modem-58  xpq? · Ghostride The Drift xpq?0001 clips
  'sc:677908197',  // modem-70  TINGO TONGO TAPES · EVENING PARTY MUSIK Final Mix 1
  'sc:972069664',  // modem-105 TINGO TONGO TAPES · Truckers
  'sc:603963846',  // modem-59  TINGO TONGO TAPES · Uncut Diamond Suite 2
]);

function fixScArtistFromTitle(data) {
  let fixed = 0;
  const unresolved = [];
  (data.tracks || []).forEach((t) => {
    if (t.kind !== 'soundcloud' || !t.title || !t.artist) return;
    if (CONFIRMED_LABEL_IS_ARTIST.has(t.key)) return;
    const labels = new Set();
    (t.shows || []).forEach((s) => (s.labels || []).forEach((l) => labels.add(String(l).trim().toLowerCase())));
    // Nothing to fix unless the scraped artist is just restating one of the
    // track's own labels (the signature of this bug — a real, distinct
    // artist name is never wrong, whatever the title looks like).
    if (!labels.has(t.artist.trim().toLowerCase())) return;

    const m = t.title.match(/^(.{1,60}?)\s+[-–—]\s+(.+)$/);
    const candidate = m && m[1].trim();
    const rest = m && m[2].trim();
    if (candidate && rest && !labels.has(candidate.toLowerCase())) {
      t.artist = candidate;
      t.artists = [candidate];
      t.title = rest;
      fixed++;
    } else {
      unresolved.push({
        key: t.key,
        title: t.title,
        artist: t.artist,
        slug: ((t.shows || [])[0] || {}).slug,
      });
    }
  });
  return { fixed, unresolved };
}

// A track's artist can end up correct through a completely different route
// than the heuristic above — e.g. a segment-level edit (segEdits, applied
// AFTER this module runs) cascading its own artist fix down onto the track —
// while the title still carries the same "Artist - " prefix redundantly,
// unstripped, because that fixed the artist without ever touching the title
// (e.g. modem-03 seg 2's "Zolitude" got its artist corrected via a segEdit
// months ago, but "Zolitude - LOR" still shows the full raw title next to
// an artist line that now already says "Zolitude"). Run this LAST — after
// every artist-setting mechanism in apply-overrides.js, segEdits included —
// so it always checks against the FINAL artist, whatever fixed it.
function stripRedundantArtistPrefix(data) {
  let stripped = 0;
  (data.tracks || []).forEach((t) => {
    if (!t.title || !t.artist) return;
    const m = t.title.match(/^(.{1,60}?)\s+[-–—]\s+(.+)$/);
    if (!m) return;
    if (m[1].trim().toLowerCase() === t.artist.trim().toLowerCase()) {
      t.title = m[2].trim();
      stripped++;
    }
  });
  return stripped;
}

module.exports = { fixScArtistFromTitle, stripRedundantArtistPrefix };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const FILE = path.join(__dirname, '..', 'src', 'assets', 'modem-archive.json');
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const { fixed, unresolved } = fixScArtistFromTitle(data);
  const stripped = stripRedundantArtistPrefix(data);
  console.log('fixed:', fixed, ' unresolved:', unresolved.length, ' redundant prefixes stripped:', stripped);
  unresolved.forEach((u) => console.log('  ' + u.slug + '  artist="' + u.artist + '"  title="' + u.title + '"'));
}
