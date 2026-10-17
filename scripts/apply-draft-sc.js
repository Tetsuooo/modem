#!/usr/bin/env node
/*
 * apply-draft-sc.js — copy the SoundCloud links picked in the show builder's
 * "Your show" list into scripts/approvals.json, so the publish pipeline's
 * apply-sc-matches.js then bakes them into the archive as `scPlay`.
 *
 * Why this is a pipeline step and not written the moment you pick: a Bandcamp
 * track only exists in modem-archive.json (under its `bc:<album>:<track>` key)
 * once the show is live and scraped, but the pick is made while the show is
 * still being built. The draft carries the pick (scPlay on the item — a
 * SoundCloud track id or URL, or null = "reviewed, no SoundCloud version"), and
 * this script moves it into approvals.json at publish time. Same shape of job
 * as apply-draft-tags.js.
 *
 * Run as part of show-builder's /publish-run, right after apply-draft-tags.js —
 * or standalone:
 *   node scripts/apply-draft-sc.js --show 249
 *
 * Draft source: current-draft.json if its showNumber matches, else the synced
 * shared-draft.json if ITS showNumber matches. Silently no-ops (exit 0) if
 * neither does, so it's safe to always run.
 *
 * Items without a pick (scPlay undefined) are left alone, and an existing
 * approvals.json entry is only replaced by an explicit pick from the draft.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APPROVALS = path.join(__dirname, 'approvals.json');
const CURRENT_DRAFT = path.join(ROOT, 'show-builder', 'data', 'current-draft.json');
const SHARED_DRAFT = path.join(ROOT, 'show-builder', 'data', 'shared-draft.json');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

const show = argVal('--show');
if (!show) {
  console.error('usage: apply-draft-sc.js --show <N> [--draft <path>]');
  process.exit(1);
}

const explicitDraft = argVal('--draft');
const current = readJson(CURRENT_DRAFT);
const shared = readJson(SHARED_DRAFT);

let draft = null;
let source = null;
if (explicitDraft) {
  draft = readJson(explicitDraft);
  source = explicitDraft;
} else if (current && String(current.showNumber) === String(show)) {
  draft = current;
  source = path.relative(ROOT, CURRENT_DRAFT);
} else if (shared && String(shared.showNumber) === String(show)) {
  draft = shared;
  source = path.relative(ROOT, SHARED_DRAFT);
}

if (!draft || !Array.isArray(draft.selected) || !draft.selected.length) {
  console.log(`apply-draft-sc: no local draft matches modem-${show} — no SoundCloud links to carry over.`);
  process.exit(0);
}

// Same key scripts/build-track-index.js gives the track once it's in the archive.
const keyOf = (it) => 'bc:' + (it.albumId || '-') + ':' + (it.trackId || '-');
const isPick = (v) => v === null || typeof v === 'number' || (typeof v === 'string' && v.trim() !== '');

const approvals = readJson(APPROVALS) || {};
let linked = 0, none = 0, unchanged = 0, undecided = 0;
for (const it of draft.selected) {
  if (it.source !== 'bandcamp-wishlist' && it.source !== 'bandcamp-library') continue;
  if (!it.albumId && !it.trackId) continue;
  if (!isPick(it.scPlay)) { undecided++; continue; }
  const key = keyOf(it);
  const val = typeof it.scPlay === 'string' ? it.scPlay.trim() : it.scPlay;
  if (JSON.stringify(approvals[key]) === JSON.stringify(val)) { unchanged++; continue; }
  approvals[key] = val;
  if (val === null) none++; else linked++;
}

if (linked || none) {
  const tmp = APPROVALS + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(approvals, null, 2));
  fs.renameSync(tmp, APPROVALS);
}
console.log(
  `apply-draft-sc: modem-${show} ← ${source} — linked:${linked} marked-none:${none} ` +
    `already-in-approvals:${unchanged} not-picked-yet:${undecided}`
);
