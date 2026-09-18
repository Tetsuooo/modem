// Keeps two show-builder data files in sync between machines via git, without
// ever letting git's own text merge touch them (that's what produced a real
// conflict prompt on the user's Surface Pro — see the commit history around
// 2026-09-18). Instead we read both the local and remote versions ourselves,
// merge them in Node with a strategy that matches what each file actually
// means, then force the working tree to a known-clean state before pulling
// so git never has anything to conflict on.
//
//  - used-tracks.json: a flat set of track keys → merge = UNION (a key
//    marked "used" on either machine should stay used everywhere).
//  - shared-draft.json: the PORTABLE subset of the active draft (selected
//    tracks minus their machine-local `_download` info, show number,
//    generated HTML) → merge = NEWEST WINS by file mtime, treated as one
//    object (not merged field-by-field — `selected` is an ordered/edited
//    list, and splicing two different orderings together would scramble it).
//    mixClips/coverLayers are deliberately NOT part of this file — both
//    reference locally-downloaded /downloads/... files that don't travel
//    with git, so "syncing" them would just point at files that don't exist
//    on the other machine.
//  - show-history.json: an append-only log of past shows (written by
//    "Start fresh" — see server.js's POST /show-history), one entry per show
//    cleared, on whichever machine cleared it → merge = UNION of entries,
//    deduped by (showNumber + clearedAt) since each clear event is a fact
//    that happened once, sorted newest-first for display.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(__dirname, 'data');
const DRAFT_FILE = path.join(DATA_DIR, 'current-draft.json');
const USED_FILE = path.join(DATA_DIR, 'used-tracks.json');
const SHARED_DRAFT_FILE = path.join(DATA_DIR, 'shared-draft.json');
const SHOW_HISTORY_FILE = path.join(DATA_DIR, 'show-history.json');

// Paths as git sees them (relative to REPO_ROOT, forward slashes).
const USED_REL = 'show-builder/data/used-tracks.json';
const SHARED_DRAFT_REL = 'show-builder/data/shared-draft.json';
const SHOW_HISTORY_REL = 'show-builder/data/show-history.json';
const MANAGED_RELS = [USED_REL, SHARED_DRAFT_REL, SHOW_HISTORY_REL];

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

// True if <ref>:<path> exists (e.g. a file that's never been committed yet —
// the very first sync ever won't have shared-draft.json on the remote).
function existsAtRef(ref, relPath) {
  try {
    // stdio 'ignore' — a missing path is an expected, handled outcome (e.g.
    // every sync before shared-draft.json's first-ever commit), not a real
    // error; git's default "fatal: path ... does not exist" would otherwise
    // print straight to the server's console on every such check.
    execFileSync('git', ['cat-file', '-e', `${ref}:${relPath}`], { cwd: REPO_ROOT, stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

function readAtRef(ref, relPath, fallback) {
  if (!existsAtRef(ref, relPath)) return fallback;
  try {
    return JSON.parse(git(['show', `${ref}:${relPath}`]));
  } catch (e) {
    return fallback;
  }
}

// The portable subset of the local draft — see file-header comment for why
// _download/mixClips/coverLayers are excluded.
function localSharedDraft() {
  const draft = readJson(DRAFT_FILE, null);
  if (!draft) return null;
  const selected = (draft.selected || []).map((it) => {
    const { _download, ...rest } = it;
    return rest;
  });
  let savedAt = 0;
  try { savedAt = fs.statSync(DRAFT_FILE).mtimeMs; } catch (e) { /* no draft yet */ }
  return { selected, showNumber: draft.showNumber || null, generatedHtml: draft.generatedHtml || null, savedAt };
}

function pickNewest(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (a.savedAt || 0) >= (b.savedAt || 0) ? a : b;
}

function mergeHistory(local, remote) {
  const byKey = new Map();
  for (const entry of [...(local || []), ...(remote || [])]) {
    byKey.set(`${entry.showNumber}@${entry.clearedAt}`, entry);
  }
  return [...byKey.values()].sort((a, b) => (b.clearedAt || '').localeCompare(a.clearedAt || ''));
}

let syncing = false;

function runSync() {
  if (syncing) return { ok: false, error: 'a sync is already running' };
  syncing = true;
  try {
    const localUsed = readJson(USED_FILE, []);
    const localShared = localSharedDraft();
    const localHistory = readJson(SHOW_HISTORY_FILE, []);

    git(['fetch', 'origin', 'main']);

    const remoteUsed = readAtRef('origin/main', USED_REL, []);
    const remoteShared = readAtRef('origin/main', SHARED_DRAFT_REL, null);
    const remoteHistory = readAtRef('origin/main', SHOW_HISTORY_REL, []);

    const mergedUsed = [...new Set([...localUsed, ...remoteUsed])].sort();
    const mergedShared = pickNewest(localShared, remoteShared);
    const mergedHistory = mergeHistory(localHistory, remoteHistory);

    // Reset the working tree to remote for exactly these managed paths so the
    // upcoming pull has nothing local to conflict with — our own merge
    // (computed above, from local+remote) gets written back over them right
    // after, regardless of what the pull leaves there.
    for (const relPath of MANAGED_RELS) {
      if (existsAtRef('origin/main', relPath)) git(['checkout', 'origin/main', '--', relPath]);
    }

    git(['pull', 'origin', 'main']);

    writeJson(USED_FILE, mergedUsed);
    if (mergedShared) writeJson(SHARED_DRAFT_FILE, mergedShared);
    writeJson(SHOW_HISTORY_FILE, mergedHistory);

    // Only add paths that actually exist on disk — SHARED_DRAFT_FILE won't
    // if this is the very first sync ever and no draft has been saved yet
    // on either machine (`git add` on a missing pathspec is a hard error).
    const paths = MANAGED_RELS.filter((relPath) => fs.existsSync(path.join(REPO_ROOT, relPath)));
    let pushed = false;
    if (paths.length) {
      git(['add', '--', ...paths]);
      const status = git(['status', '--short', '--', ...paths]);
      if (status.trim()) {
        git(['commit', '-m', 'show-builder: sync used-tracks + draft + history [skip ci]']);
        git(['push']);
        pushed = true;
      }
    }

    return { ok: true, pushed, shared: mergedShared, usedCount: mergedUsed.length, history: mergedHistory };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    syncing = false;
  }
}

function getHistory() {
  return readJson(SHOW_HISTORY_FILE, []);
}

// Called by POST /show-history when "Start fresh" archives the current
// draft before clearing it. Local-only (like the rest of a plain save) — it
// only reaches the other machine on the next explicit Sync, same as every
// other local edit.
function addHistoryEntry(entry) {
  const history = getHistory();
  history.unshift(entry);
  writeJson(SHOW_HISTORY_FILE, history);
  return history;
}

module.exports = { runSync, getHistory, addHistoryEntry };
