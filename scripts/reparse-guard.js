#!/usr/bin/env node
/*
 * reparse-guard.js — keep what a `scrape-modem.js --reparse` would throw away.
 *
 * --reparse (used by the tag tools when an edit has to be UNDONE, so the
 * original spellings can be re-derived from the source) rebuilds every record
 * from the cached radiostudent.si page. Several things on a record are NOT on
 * that page, so a bare reparse silently loses them (see also the note at the
 * top of backfill-show-audio.js):
 *   • artists / labels — filled from the show-builder draft by apply-draft-tags.js
 *     when radiostudent.si's own fields were never filled in (the modem-248 incident)
 *   • mp3 / soundcloud — patched in later by backfill-show-audio.js
 *   • the segment-marker fixes (fix-missing-segments.js) — apply-overrides.js applies
 *     them LAST, but build-track-index.js derives each track's segment label from
 *     the markers, so they have to be back in place before it runs
 *   • counts.lastScraped — bookkeeping, but a reparse rewrites it as every slug
 *     in the archive, which only makes the archive diff noisy
 *
 * The tag tools bracket the reparse with this script:
 *   node scripts/reparse-guard.js --snapshot   # before — remember all of the above
 *   node scripts/scrape-modem.js --reparse
 *   node scripts/reparse-guard.js --restore    # after  — put it back
 *
 * --restore only fills a gap: a record's artists/labels come back only if the
 * reparse left it with NO artists AND NO labels but it had some before; mp3 and
 * soundcloud only if now empty but set before. Anything the reparse found on the
 * page stays as the page has it.
 *
 * The restored tag names are the ones already in the archive (post tag-merge);
 * the overrides step that follows maps them again, so a merge applies as normal.
 * The one limitation: UN-merging a tag does not bring back the pre-merge
 * spelling on such a record, since its original isn't on the page to re-derive.
 */
const fs = require('fs');
const path = require('path');
const { applySegMarkerFixes } = require('./fix-missing-segments');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const SNAPSHOT = path.join(__dirname, '.cache', 'reparse-guard-snapshot.json');

const mode = process.argv.includes('--snapshot') ? 'snapshot' : process.argv.includes('--restore') ? 'restore' : null;
if (!mode) {
  console.error('usage: reparse-guard.js --snapshot | --restore');
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(ARCHIVE, 'utf8'));
const hasTags = (r) => (r.artists || []).length > 0 || (r.labels || []).length > 0;

if (mode === 'snapshot') {
  const records = {};
  for (const r of data.records || []) {
    if (hasTags(r) || r.mp3 || r.soundcloud) {
      records[r.slug] = { artists: r.artists || [], labels: r.labels || [], searchText: r.searchText, mp3: r.mp3 || null, soundcloud: r.soundcloud || null };
    }
  }
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  fs.writeFileSync(SNAPSHOT, JSON.stringify({ records, lastScraped: (data.counts || {}).lastScraped }));
  console.log('reparse-guard: snapshot of ' + Object.keys(records).length + ' records');
} else {
  let snap;
  try { snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')); } catch (e) {
    console.error('reparse-guard: no snapshot to restore from (run --snapshot first)');
    process.exit(1);
  }
  const restored = [];
  for (const r of data.records || []) {
    const s = snap.records[r.slug];
    if (!s) continue;
    const got = [];
    if (!hasTags(r) && ((s.artists || []).length || (s.labels || []).length)) {
      r.artists = s.artists; r.labels = s.labels;
      if (s.searchText != null) r.searchText = s.searchText;
      got.push('tags');
    }
    if (!r.mp3 && s.mp3) { r.mp3 = s.mp3; got.push('mp3'); }
    if (!r.soundcloud && s.soundcloud) { r.soundcloud = s.soundcloud; got.push('soundcloud'); }
    if (got.length) restored.push(r.slug + ' (' + got.join('+') + ')');
  }
  if (snap.lastScraped) data.counts = { ...data.counts, lastScraped: snap.lastScraped };
  applySegMarkerFixes(data);
  fs.writeFileSync(ARCHIVE, JSON.stringify(data, null, 2));
  console.log('reparse-guard: restored ' + restored.length + ' record(s)' + (restored.length ? ': ' + restored.join(', ') : '') + '; segment-marker fixes re-applied');
}
