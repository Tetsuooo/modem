// The parsed live archive (src/assets/modem-archive.json, ~13 MB), cached by
// file mtime so the site-tool routes don't re-parse it on every request — only
// after a job (apply-sc-matches.js, apply-overrides.js, a publish) rewrites it.
const fs = require('fs');
const path = require('path');

const ARCHIVE_FILE = path.join(__dirname, '..', 'src', 'assets', 'modem-archive.json');
const OVERRIDES_FILE = path.join(__dirname, '..', 'src', 'assets', 'overrides.json');

let cache = null; // { mtimeMs, data }

function getArchive() {
  const mtimeMs = fs.statSync(ARCHIVE_FILE).mtimeMs;
  if (cache && cache.mtimeMs === mtimeMs) return cache.data;
  const data = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  cache = { mtimeMs, data };
  return data;
}

// Always read fresh (small file, and the tag tool edits it).
function getOverrides() {
  try {
    const o = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    return { ...o, tagMerges: o.tagMerges || {}, tagEdits: o.tagEdits || {}, segEdits: o.segEdits || {} };
  } catch (e) {
    return { tagMerges: {}, tagEdits: {}, segEdits: {} };
  }
}

// Write via a temp file + rename so a crash mid-write can't leave a
// half-written (unparseable) JSON file for the site build to choke on.
function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

module.exports = { ARCHIVE_FILE, OVERRIDES_FILE, getArchive, getOverrides, writeJsonAtomic };
