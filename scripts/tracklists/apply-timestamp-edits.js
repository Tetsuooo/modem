#!/usr/bin/env node
/*
 * apply-timestamp-edits.js — put Matej's hand-set track start times (the show
 * builder's "Tracklist" tab) into src/assets/show-timestamps.json.
 *
 * The fixes live in src/assets/overrides.json → "timeEdits", a flat map
 *   "<slug>::<rowId>": <seconds> | false
 * (seconds = where that track starts; false = "not played in this show", hidden on
 * the site). rowId = the track's site key ("bc:…", "sc:…"), or "n:<artist title>"
 * for a track that isn't on the show page. Flat, so the show builder's Sync merges
 * it per entry between the two machines (show-builder/sync.js), like tag edits.
 *
 * Reversible and idempotent: an edited row keeps its own time in t0 (and approx0),
 * so taking a fix back restores it, and running this twice changes nothing. Rows are
 * re-sorted by time afterwards. Runs in both publish pipelines (show-builder/server.js)
 * and after build_tracklists.py writes the file.
 *
 *   node scripts/tracklists/apply-timestamp-edits.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const TIMESTAMPS = path.join(ROOT, 'src', 'assets', 'show-timestamps.json');
const OVERRIDES = path.join(ROOT, 'src', 'assets', 'overrides.json');

const norm = (s) => String(s == null ? '' : s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const rowId = (x) => (x.key ? x.key : 'n:' + norm((x.artist || '') + ' ' + (x.title || '')));

// one show's rows with the edits for it applied (edits: { rowId: seconds | false });
// returns { tracks, fixed, hidden } — the input is not modified
function applyToShow(tracks, edits) {
  let fixed = 0, hidden = 0;
  const out = (tracks || []).map((src) => {
    const x = { ...src };
    // back to what matching / the builder gave this row
    if ('t0' in x) { x.t = x.t0; if (x.approx0) x.approx = true; else delete x.approx; }
    delete x.t0; delete x.approx0; delete x.fixed; delete x.hidden;
    const e = edits ? edits[rowId(x)] : undefined;
    if (e === false || typeof e === 'number') {
      x.t0 = x.t; if (x.approx) x.approx0 = true;
      if (e === false) { x.hidden = true; hidden++; }
      else { x.t = Math.round(Math.max(0, e) * 10) / 10; delete x.approx; x.fixed = true; fixed++; }
    }
    return x;
  });
  out.sort((a, b) => a.t - b.t);
  return { tracks: out, fixed, hidden };
}

// overrides.timeEdits → { slug: { rowId: value } }
function editsBySlug(timeEdits) {
  const by = {};
  for (const [k, v] of Object.entries(timeEdits || {})) {
    const i = k.indexOf('::');
    if (i < 0) continue;
    (by[k.slice(0, i)] = by[k.slice(0, i)] || {})[k.slice(i + 2)] = v;
  }
  return by;
}

function applyAll(data, timeEdits) {
  const by = editsBySlug(timeEdits);
  const report = [];
  for (const [slug, show] of Object.entries((data && data.shows) || {})) {
    const r = applyToShow(show.tracks, by[slug]);
    show.tracks = r.tracks;
    if (r.fixed || r.hidden) report.push(`${slug}: ${r.fixed} start time${r.fixed === 1 ? '' : 's'} set by hand${r.hidden ? `, ${r.hidden} hidden (not played)` : ''}`);
  }
  return report;
}

module.exports = { rowId, applyToShow, editsBySlug, applyAll };

if (require.main === module) {
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const data = read(TIMESTAMPS, null);
  if (!data) { console.log('apply-timestamp-edits: no show-timestamps.json yet — nothing to do'); process.exit(0); }
  const before = JSON.stringify(data);
  const report = applyAll(data, (read(OVERRIDES, {}) || {}).timeEdits);
  const after = JSON.stringify(data);
  if (after !== before) fs.writeFileSync(TIMESTAMPS, after);
  console.log('apply-timestamp-edits: ' + (report.length ? report.join('; ') : 'no hand-set start times') + (after !== before ? '' : ' (file unchanged)'));
}
