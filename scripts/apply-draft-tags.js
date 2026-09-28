#!/usr/bin/env node
/*
 * apply-draft-tags.js — after scrape-modem.js scrapes a freshly-published
 * show's live radiostudent.si page, overwrite that ONE record's artists/
 * labels with the ones computed from the show-builder draft that built it
 * (see show-builder/build-record-tags.js), instead of trusting
 * radiostudent.si's own "umetniki"/"založba" taxonomy fields. Those are a
 * separate manual tagging step on RS's own admin page that's easy to forget —
 * the modem-248 incident: the tracklist body was live and correct, but the
 * tag fields were never filled in on RS's side, so scrape-modem.js came back
 * with artists:0 labels:0 despite show-builder's own Arrange tab already
 * having the right names (and Preview already rendering them correctly).
 *
 * Leaves bodyHtml/segments/embeds/cover/date/mp3/soundcloud alone — those
 * come from the live page, which IS reliable (it's literally the HTML
 * show-builder generated and the DJ pasted in verbatim).
 *
 * Run as part of show-builder's /publish-run, right after scrape-modem.js —
 * or standalone, once a draft has been synced to this machine:
 *   node scripts/apply-draft-tags.js --show 248
 *
 * Draft source: current-draft.json (this machine's own, gitignored) if its
 * showNumber matches, else shared-draft.json (the portable, git-synced copy —
 * see show-builder/sync.js) if ITS showNumber matches. Silently no-ops (exit
 * 0) if neither matches — safe to always run in the pipeline even when no
 * local draft covers the show being published (e.g. an older show, or one
 * built on a machine that hasn't synced yet).
 */
const fs = require('fs');
const path = require('path');
const { buildRecordTags } = require('../show-builder/build-record-tags');
const { stripTags } = require('./scrape-modem');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const CURRENT_DRAFT = path.join(ROOT, 'show-builder', 'data', 'current-draft.json');
const SHARED_DRAFT = path.join(ROOT, 'show-builder', 'data', 'shared-draft.json');

function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const show = argVal('--show');
if (!show) {
  console.error('usage: apply-draft-tags.js --show <N> [--draft <path>]');
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
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
  console.log(
    `apply-draft-tags: no local draft matches modem-${show} ` +
      `(current-draft.json: ${current ? 'show ' + current.showNumber : 'missing'}, ` +
      `shared-draft.json: ${shared ? 'show ' + shared.showNumber : 'missing'}) ` +
      `— leaving radiostudent.si-scraped artists/labels as-is.`
  );
  process.exit(0);
}

const data = readJson(ARCHIVE_FILE);
if (!data) {
  console.error('apply-draft-tags: could not read ' + ARCHIVE_FILE);
  process.exit(1);
}
const slug = `modem-${show}`;
const record = (data.records || []).find((r) => r.slug === slug);
if (!record) {
  console.error(`apply-draft-tags: no record for ${slug} in modem-archive.json — run scrape-modem.js first.`);
  process.exit(1);
}

const before = { artists: record.artists.length, labels: record.labels.length };
const { artists, labels } = buildRecordTags(draft.selected);
record.artists = artists;
record.labels = labels;
record.searchText = [
  record.title,
  record.date,
  artists.map((a) => a.name).join(' '),
  labels.map((l) => l.name).join(' '),
  stripTags(record.bodyHtml || ''),
]
  .filter(Boolean)
  .join(' \n ');

fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(data, null, 2));
console.log(
  `apply-draft-tags: ${slug} ← ${source} — artists:${before.artists}→${artists.length} labels:${before.labels}→${labels.length}`
);
