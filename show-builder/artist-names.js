// Autocomplete source for the "Your show" artist/label edit fields — every
// artist/label credit already used across the live archive (the same tags
// the site's own search/chips index reads from src/assets/modem-archive.json's
// records[].artists[]/labels[]), canonicalised through overrides.json's
// tagMerges so typing a known variant surfaces the name already in use
// instead of spawning a near-duplicate tag. Cached by the archive file's
// mtime, same pattern as duplicate-check.js's own index.
const fs = require('fs');
const path = require('path');

const ARCHIVE_FILE = path.join(__dirname, '..', 'src', 'assets', 'modem-archive.json');
const OVERRIDES_FILE = path.join(__dirname, '..', 'src', 'assets', 'overrides.json');

let cache = null; // { mtimeMs, artists, labels }

function sortNames(set) {
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

function getNames() {
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(ARCHIVE_FILE).mtimeMs;
  } catch (e) {
    return { artists: [], labels: [] }; // archive not built yet — best-effort, just skip
  }
  if (cache && cache.mtimeMs === mtimeMs) return cache;

  const archive = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  let tagMerges = {};
  try {
    tagMerges = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8')).tagMerges || {};
  } catch (e) { /* no overrides yet */ }
  const canon = (name) => tagMerges[name] || name;

  const artists = new Set();
  const labels = new Set();
  for (const r of archive.records || []) {
    for (const a of r.artists || []) { const n = canon((a.name || '').trim()); if (n) artists.add(n); }
    for (const l of r.labels || []) { const n = canon((l.name || '').trim()); if (n) labels.add(n); }
  }
  cache = { mtimeMs, artists: sortNames(artists), labels: sortNames(labels) };
  return cache;
}

module.exports = { getNames };
