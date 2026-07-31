#!/usr/bin/env node
/*
 * apply-sc-matches.js — write approved Bandcamp→SoundCloud matches into
 * src/assets/modem-archive.json as a `scPlay` field on the matched track.
 *
 * A Bandcamp track with `scPlay` streams from that SoundCloud upload in the
 * custom player, while its link/label stay Bandcamp (audio from SC, credit to BC).
 * Untouched Bandcamp tracks keep opening Bandcamp as before.
 *
 * Also resolves and stores the SoundCloud track's own title/artist
 * (scPlayTitle/scPlayArtist) — archive.html's display prefers these over the
 * Bandcamp track's own title/artist whenever they're set. Needed because a
 * Bandcamp embed for a whole album (no single track highlighted) scrapes its
 * title as just the album name — matched to a specific SC track, that generic
 * album name is what used to show while a completely different, specific
 * track actually played (e.g. modem-242's "lovejector" album embed streaming
 * the specific track "anything helps" via scPlay, but still labelled
 * "lovejector" everywhere — confusing when the audio and the label disagree).
 * Resolved via SoundCloud's oembed endpoint, cached like every other network
 * call in this pipeline (scripts/.cache/) — a fresh scPlay id costs one live
 * lookup, already-resolved ones are instant on every later run.
 *
 * Sources, in order of precedence:
 *   1. scripts/approvals.json      — exported from sc-match-review.html (if present)
 *   2. the "auto" tier             — airtight matches from sc-match-candidates.json
 * An approvals entry of `null` means "reviewed, no match" and clears any scPlay.
 *
 * Usage: node scripts/apply-sc-matches.js [--fresh]
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const CAND = path.join(__dirname, 'sc-match-candidates.json');
const APPROVALS = path.join(__dirname, 'approvals.json');
const CACHE_DIR = path.join(__dirname, '.cache');
const FRESH = process.argv.includes('--fresh');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const CONCURRENCY = 12;

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const cands = fs.existsSync(CAND) ? JSON.parse(fs.readFileSync(CAND, 'utf8')) : [];
const approvals = fs.existsSync(APPROVALS) ? JSON.parse(fs.readFileSync(APPROVALS, 'utf8')) : {};

// key → decided SoundCloud track id (or null = explicitly no match)
const decided = {};
for (const o of cands) if (o.tier === 'auto' && o.suggest) decided[o.key] = o.suggest;
for (const k of Object.keys(approvals)) decided[k] = approvals[k]; // manual overrides win

const byKey = {};
data.tracks.forEach((t) => (byKey[t.key] = t));

// candidates(auto) + approvals are the source of truth: clear every scPlay, then set.
let cleared = 0;
data.tracks.forEach((t) => {
  if (t.scPlay != null) { delete t.scPlay; cleared++; }
  delete t.scPlayTitle;
  delete t.scPlayArtist;
});
let set = 0, missing = 0;
const toResolve = []; // [{ track, scPlayValue }]
for (const key of Object.keys(decided)) {
  const t = byKey[key];
  if (!t) { missing++; continue; }
  const id = decided[key];
  if (id && (t.shows || []).some((s) => s.type === 'show')) {
    t.scPlay = /^https?:/i.test(String(id)) ? String(id).trim() : Number(id);
    set++;
    toResolve.push(t);
  }
}

function curlCached(key, url) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    const cacheFile = path.join(CACHE_DIR, 'scplay-' + key.replace(/[^\w.-]/g, '_'));
    if (!FRESH && fs.existsSync(cacheFile)) return resolve(fs.readFileSync(cacheFile, 'utf8'));
    execFile(
      'curl',
      ['-sS', '-L', '--compressed', '--max-time', '25', '-A', UA, '-H', 'Accept-Language: en;q=0.9', url],
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve(null);
        fs.writeFileSync(cacheFile, stdout);
        resolve(stdout);
      }
    );
  });
}

async function resolveOne(t) {
  const isUrl = /^https?:/i.test(String(t.scPlay));
  const target = isUrl ? String(t.scPlay).trim() : 'https://api.soundcloud.com/tracks/' + t.scPlay;
  const cacheKey = isUrl ? String(t.scPlay).replace(/[^\w.-]/g, '_') : String(t.scPlay);
  const oembed = 'https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(target);
  const body = await curlCached(cacheKey + '.json', oembed);
  if (!body) return;
  try {
    const j = JSON.parse(body);
    if (!j || !j.title) return;
    let title = j.title;
    const artist = j.author_name || null;
    if (artist && title.endsWith(' by ' + artist)) title = title.slice(0, -(' by ' + artist).length);
    if (title) t.scPlayTitle = title;
    if (artist) t.scPlayArtist = artist;
    // build-track-index.js already built searchText from the Bandcamp title —
    // append the streamed track's real title/artist too so searching for it
    // by its actual name (not the generic Bandcamp one) finds it.
    const extra = [title, artist].filter(Boolean).join(' \n ');
    if (extra && t.searchText && t.searchText.indexOf(extra) === -1) t.searchText += ' \n ' + extra;
  } catch (e) { /* leave unresolved — display falls back to the Bandcamp title */ }
}

async function resolveAll(tracks) {
  let i = 0, resolved = 0;
  async function worker() {
    while (i < tracks.length) {
      const t = tracks[i++];
      await resolveOne(t);
      resolved++;
      if (resolved % 100 === 0) process.stdout.write('  … resolved ' + resolved + '/' + tracks.length + ' scPlay titles\r\n');
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tracks.length) }, worker));
}

resolveAll(toResolve).then(() => {
  data.counts = data.counts || {};
  data.counts.scMatched = data.tracks.filter((t) => t.scPlay).length;
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
  const titled = toResolve.filter((t) => t.scPlayTitle).length;
  console.log(
    'Applied SoundCloud matches → ' + path.relative(ROOT, FILE) + '\n' +
      '  set scPlay: ' + set + '  cleared: ' + cleared + '  (unknown keys: ' + missing + ')\n' +
      '  total bandcamp tracks now streamable via SoundCloud: ' + data.counts.scMatched + '\n' +
      '  scPlay titles resolved: ' + titled + '/' + toResolve.length
  );
});
