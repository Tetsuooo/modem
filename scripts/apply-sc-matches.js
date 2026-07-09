#!/usr/bin/env node
/*
 * apply-sc-matches.js — write approved Bandcamp→SoundCloud matches into
 * src/assets/modem-archive.json as a `scPlay` field on the matched track.
 *
 * A Bandcamp track with `scPlay` streams from that SoundCloud upload in the
 * custom player, while its link/label stay Bandcamp (audio from SC, credit to BC).
 * Untouched Bandcamp tracks keep opening Bandcamp as before.
 *
 * Sources, in order of precedence:
 *   1. scripts/approvals.json      — exported from sc-match-review.html (if present)
 *   2. the "auto" tier             — airtight matches from sc-match-candidates.json
 * An approvals entry of `null` means "reviewed, no match" and clears any scPlay.
 *
 * Usage: node scripts/apply-sc-matches.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const CAND = path.join(__dirname, 'sc-match-candidates.json');
const APPROVALS = path.join(__dirname, 'approvals.json');

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
data.tracks.forEach((t) => { if (t.scPlay != null) { delete t.scPlay; cleared++; } });
let set = 0, missing = 0;
for (const key of Object.keys(decided)) {
  const t = byKey[key];
  if (!t) { missing++; continue; }
  const id = decided[key];
  // only ever set scPlay on tracks actually played in a show (not list albums)
  if (id && (t.shows || []).some((s) => s.type === 'show')) {
    t.scPlay = /^https?:/i.test(String(id)) ? String(id).trim() : Number(id);
    set++;
  }
}

data.counts = data.counts || {};
data.counts.scMatched = data.tracks.filter((t) => t.scPlay).length;

fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
console.log(
  'Applied SoundCloud matches → ' + path.relative(ROOT, FILE) + '\n' +
    '  set scPlay: ' + set + '  cleared: ' + cleared + '  (unknown keys: ' + missing + ')\n' +
    '  total bandcamp tracks now streamable via SoundCloud: ' + data.counts.scMatched
);
