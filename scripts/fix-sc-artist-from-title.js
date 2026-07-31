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
 * Applied in apply-overrides.js so it survives --reparse.
 */
function fixScArtistFromTitle(data) {
  let fixed = 0;
  const unresolved = [];
  (data.tracks || []).forEach((t) => {
    if (t.kind !== 'soundcloud' || !t.title || !t.artist) return;
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

module.exports = { fixScArtistFromTitle };

if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const FILE = path.join(__dirname, '..', 'src', 'assets', 'modem-archive.json');
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const { fixed, unresolved } = fixScArtistFromTitle(data);
  console.log('fixed:', fixed, ' unresolved:', unresolved.length);
  unresolved.forEach((u) => console.log('  ' + u.slug + '  artist="' + u.artist + '"  title="' + u.title + '"'));
}
