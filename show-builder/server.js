// Local show-builder tool: scan SoundCloud reposts + Bandcamp wishlist/library
// for anything from the last N days, pick tracks, download them (reusing
// modem_download.py as-is), drag into order, generate the tracklist HTML to
// paste into radioštudent. Standalone from the main site's server.js/:8085 —
// own port, own process, nothing here touches the live site.
//
// Also hosts the site-maintenance tools that used to live on :8085 / the
// site's admin page, so a show can be built and the site tidied in one place:
//   • per-track + backlog Bandcamp→SoundCloud linking   (sc-links.js, /sc/*)
//   • doubled-tag finder / merger / per-release editor  (tag-tools.js, /tags/*)
// Those two DO write to the site's own data (scripts/approvals.json,
// src/assets/overrides.json, src/assets/modem-archive.json) — the edits go
// live with the next publish push, like everything else in the working tree.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execFile, execFileSync, exec } = require('child_process');

const scanSoundcloud = require('./scan-soundcloud');
const scanBandcamp = require('./scan-bandcamp');
const { generateShowHtml } = require('./generate-html');
const { previewDraft } = require('./preview');
const { curlGet } = require('./lib');
const { checkDuplicate } = require('./duplicate-check');
const { getNames } = require('./artist-names');
const { runSync, getHistory, addHistoryEntry } = require('./sync');
const scLinks = require('./sc-links');
const tagTools = require('./tag-tools');
const siteTools = require('./site-tools');
const timeTools = require('./time-tools');
const yearEnd = require('./year-end');
const health = require('./health');
const { undoesSomething } = tagTools;
const { compareWithLive } = require('./compare-live');
const { getArchive } = require('./archive-cache');

// Shared between /publish-run's pre-flight guard and /publish-push's
// pre-commit guard below — the residue pattern from a real incident (a
// scrape-modem.js bug re-scraping best-releases-of-2025 alongside an
// unrelated show, since fixed) that both checks exist to catch.
// scripts/approvals.json + src/assets/overrides.json are the files the
// SoundCloud-links and Tags tabs write (see sc-links.js / tag-tools.js) — their
// edits are meant to ride along with the next publish, not block it. Same for
// src/assets/builder-shows.json, the as-built copy of each show published from
// the draft (scripts/add-show-from-draft.js), and src/assets/show-timestamps.json,
// the live tracklist's track times that same script takes from the Mix tab.
const EXPECTED_DIRTY = /(^|\/)(src\/assets\/modem-archive\.json|show-builder\/data\/used-tracks\.json|scripts\/approvals\.json|src\/assets\/overrides\.json|src\/assets\/builder-shows\.json|src\/assets\/show-timestamps\.json)$|(^|\/)(src\/assets\/modem_covers\/|docs\/)/;
const LIST_SLUG_PATTERN = /best-releases|best-labels|best-videos|best-of-|community-lists/i;

const REPO_ROOT = path.join(__dirname, '..');
// macOS/Linux don't ship a bare `python` (it's `python3`); Windows has no
// `python3` by default. Everything else here (Node, curl, git) is already
// cross-platform.
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Lets the browser play downloaded files directly (native <audio>) once a
// track is on disk, instead of the source platform's iframe embed.
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));
// the site's own copies of show covers: a show built here has "assets/modem_covers/…" as its
// cover, which Edit site shows (it was a broken image there)
app.use('/assets/modem_covers', express.static(path.join(REPO_ROOT, 'src', 'assets', 'modem_covers')));

// modem_download.py copies every cover (single tracks via embed_cover_single,
// albums via copy_album_cover_to_global) here, renamed "<title>_cover.jpg" —
// one flat folder with every cover regardless of where the track lives.
const COVERS_DIR = path.join(__dirname, 'downloads', '_covers');

const DATA_DIR = path.join(__dirname, 'data');
const DRAFT_FILE = path.join(DATA_DIR, 'current-draft.json');
const USED_FILE = path.join(DATA_DIR, 'used-tracks.json');
const MANIFEST_FILE = path.join(DATA_DIR, 'download-manifest.jsonl');
const URLS_FILE = path.join(DATA_DIR, 'download-urls.txt');
const DAYS_BACK = 14;

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

// ---------- /next-show-number ------------------------------------------------
// Best-effort default for the "Show #" field: one past the latest show
// already in the site's own archive (same file scripts/auto-update.js reads
// to detect new shows). Purely a starting suggestion — the field stays editable.
app.get('/next-show-number', (req, res) => {
  try {
    const archive = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'assets', 'modem-archive.json'), 'utf8'));
    const nums = (archive.records || [])
      .filter((r) => r.type === 'show' && typeof r.number === 'number')
      .map((r) => r.number);
    res.json({ next: nums.length ? Math.max(...nums) + 1 : null });
  } catch (e) {
    res.json({ next: null });
  }
});

// ---------- /artist-label-names ---------------------------------------------
// Populates the artist/label edit-field autocomplete in "Your show" — see
// artist-names.js for how the list is built.
app.get('/artist-label-names', (req, res) => {
  res.json({ ok: true, ...getNames() });
});

// ---------- SoundCloud links + Edit site tabs --------------------------------
// The routes live in their own modules (/sc/*, /tags/*, /site/*, /times/*).
scLinks.mount(app);
tagTools.mount(app);
timeTools.mount(app);
yearEnd.mount(app);
const healthApi = health.mount(app);
siteTools.mount(app, { previewPort: Number(process.env.PREVIEW_PORT) || 8091 });

// ---------- /scan ----------------------------------------------------------
app.post('/scan', (req, res) => {
  const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
  const used = new Set(readJson(USED_FILE, []));
  const errors = [];
  let items = [];

  try {
    items = items.concat(scanSoundcloud.scanReposts(cutoff));
  } catch (e) {
    errors.push({ source: 'soundcloud', error: String(e.message || e) });
  }
  try {
    items = items.concat(scanBandcamp.scanWishlistAndLibrary(cutoff));
  } catch (e) {
    errors.push({ source: 'bandcamp', error: String(e.message || e) });
  }

  items = items.filter((it) => !used.has(it.key));
  items.sort((a, b) => new Date(b.date) - new Date(a.date));
  // Flag anything that already appeared in a past modem show, matched
  // against scripts/build-track-index.js's flat track index — see
  // duplicate-check.js for the key scheme.
  for (const it of items) {
    const dup = checkDuplicate(it);
    if (dup) it.previouslyPlayed = dup;
  }
  res.json({ ok: true, items, errors, cutoff: cutoff.toISOString() });
});

// ---------- /release-tracks (expand a playlist/album into its tracks) ------
// Bandcamp albums already carry `tracks` from /scan (checkReleaseStatus
// fetches the release page anyway, for the pre-order flag) — nothing more to
// resolve normally. SoundCloud playlists don't, since resolving them costs
// extra requests only worth paying when a row is actually expanded. The
// scanBandcamp.fetchAlbumTracks() fallback only fires for an album item that
// somehow never got its `tracks` cached (e.g. a very old "Your show" entry
// picked before this field existed, or the original scan's page fetch
// failed) — a fresh re-fetch instead of just reflecting back nothing.
app.post('/release-tracks', (req, res) => {
  const item = (req.body && req.body.item) || {};
  try {
    const isSc = item.source === 'soundcloud';
    const tracks = isSc
      ? scanSoundcloud.resolveTracks(item)
      : (item.tracks && item.tracks.length ? item.tracks : scanBandcamp.fetchAlbumTracks(item));
    // Each sub-track needs its own duplicate check — a Bandcamp album track
    // has its own trackId (checked against the parent's albumId), while a
    // resolved SoundCloud track is checked by its own id directly.
    for (const t of tracks) {
      const dup = isSc
        ? checkDuplicate({ source: 'soundcloud', key: 'sc:' + t.id })
        : checkDuplicate({ source: item.source, albumId: item.albumId, trackId: t.id });
      if (dup) t.previouslyPlayed = dup;
    }
    return res.json({ ok: true, tracks });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- /preview-stream (inline background preview, Scan tab) ----------
// Resolves a single track to a directly-playable audio URL so the Scan tab
// can preview it with the same plain <audio>-based track-player UI used for
// downloaded tracks, instead of an embedded platform widget per preview —
// see scan-soundcloud.js/scan-bandcamp.js's resolveStreamUrl(). Only ever
// called for a single playable track (see isSingleTrackPreview() client-
// side) — playlists/whole albums still use the old tracklist iframe.
// `duration` rides along on every response (even ok:false, e.g. an
// HLS-only SoundCloud track) since it's already resolved for free — also
// used to backfill an old "Your show" entry's missing length, see
// backfillItemDuration() in index.html.
app.post('/preview-stream', (req, res) => {
  const item = (req.body && req.body.item) || {};
  try {
    const result = item.source === 'soundcloud'
      ? scanSoundcloud.resolveStreamUrl(item.url)
      : scanBandcamp.resolveStreamUrl(item.url, item.trackId);
    if (!result.url) return res.json({ ok: false, error: 'no direct stream available for this track', duration: result.duration });
    // hls: an .m3u8 (SoundCloud since Oct 2026) — trackPlayerHtml() plays it through hls.js
    res.json({ ok: true, url: result.url, duration: result.duration, hls: !!result.hls });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- /release-label ----------------------------------------------------
// A track's label, for one picked before the builder read labels (scans do it
// themselves since 2026-10-24): Bandcamp → its release page (labelFromPage() in
// scan-bandcamp.js), SoundCloud → the uploader's "record label" field. label: null =
// looked, there's none (self-released) — the page then won't ask again.
app.post('/release-label', (req, res) => {
  const it = (req.body && req.body.item) || {};
  if (!it.url) return res.status(400).json({ ok: false, error: 'no url' });
  try {
    const label = it.source === 'soundcloud' ? scanSoundcloud.trackLabel(it.url) : scanBandcamp.releaseLabel(it.url, it.artist);
    res.json({ ok: true, label: label || null });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- draft persistence ----------------------------------------------
app.get('/draft', (req, res) => {
  res.json(readJson(DRAFT_FILE, { selected: [], order: [], generatedHtml: null }));
});
app.post('/draft', (req, res) => {
  writeJson(DRAFT_FILE, req.body || {});
  res.json({ ok: true });
});

// ---------- /sync -----------------------------------------------------------
// One-click git pull+merge+push for the two cross-machine data files — see
// sync.js for the merge strategy (union for used-tracks, newest-wins for the
// portable draft subset). Runs synchronously: a few small-text-file git
// operations, not a multi-minute pipeline like /publish-run, so no job+poll
// pattern is needed here.
app.post('/sync', (req, res) => {
  const result = runSync();
  // the pull can bring new builder code, which this running server won't use until it restarts
  if (result.ok) result.restartNeeded = healthApi.restartNeeded();
  res.status(result.ok ? 200 : 500).json(result);
});

// ---------- /show-history ----------------------------------------------------
// A lightweight, append-only log of past shows — written by "Start fresh"
// right before it clears the active draft, so nothing is silently lost, just
// archived. Synced across machines via /sync (union merge, see sync.js).
app.get('/show-history', (req, res) => {
  res.json({ ok: true, history: getHistory() });
});
app.post('/show-history', (req, res) => {
  const { showNumber, tracks } = req.body || {};
  if (!showNumber || !Array.isArray(tracks) || !tracks.length) {
    return res.status(400).json({ ok: false, error: 'showNumber and a non-empty tracks list are required' });
  }
  const entry = { showNumber: String(showNumber), clearedAt: new Date().toISOString(), tracks };
  const history = addHistoryEntry(entry);
  res.json({ ok: true, history });
});

// ---------- /download (background job, mirrors server.js's findJob) --------
let downloadJob = null; // { running, done, error, log, urls, results }

app.post('/download', (req, res) => {
  if (downloadJob && downloadJob.running) return res.json({ ok: true, already: true });
  const items = (req.body && req.body.items) || [];
  const urls = [...new Set(items.map((it) => it.url).filter(Boolean))];
  if (!urls.length) return res.status(400).json({ ok: false, error: 'no urls given' });

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(URLS_FILE, urls.join('\n') + '\n');

  downloadJob = { running: true, done: false, error: null, log: ['starting downloads…'], urls, results: null };
  const child = spawn(PYTHON_CMD, [path.join(__dirname, 'modem_download.py'), URLS_FILE], { cwd: __dirname });
  const push = (buf) => {
    String(buf).split(/\r?\n/).forEach((l) => { if (l.trim()) downloadJob.log.push(l.trim()); });
    if (downloadJob.log.length > 400) downloadJob.log = downloadJob.log.slice(-400);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => { downloadJob.running = false; downloadJob.error = String(e.message || e); });
  child.on('close', (code) => {
    downloadJob.running = false;
    downloadJob.done = code === 0;
    if (code !== 0) downloadJob.error = 'modem_download.py exited ' + code;
    downloadJob.results = matchManifest(downloadJob.urls);
  });

  res.json({ ok: true, started: true });
});

app.get('/download-status', (req, res) => {
  if (!downloadJob) return res.json({ running: false, done: false, log: [] });
  res.json({
    running: downloadJob.running,
    done: downloadJob.done,
    error: downloadJob.error,
    progress: downloadJob.log[downloadJob.log.length - 1] || '',
    log: downloadJob.log.slice(-15),
    results: downloadJob.results,
  });
});

// modem_download.py's sanitize_filename(), ported — must match exactly so
// the fallback below re-derives the same _covers filename it would have
// written.
function sanitizeForCoverMatch(name) {
  return String(name).replace(/[:/\\<>"|?*]/g, '_').trim();
}

// A record whose cover is null could just genuinely have none — OR could be
// an already-downloaded track re-scanned before this fix existed (older
// runs of modem_download.py's skip-path always wrote null, even when the
// cover file was sitting right there in _covers/ from the original
// download). Re-derive the expected filename the same way
// embed_cover_single()/copy_album_cover_to_global() name it, and use it if
// it actually exists on disk — self-heals on the next scan/download poll,
// no re-download needed.
function coverFallback(rec) {
  if (rec.cover) return rec.cover;
  let base;
  if (rec.kind === 'playlist' && rec.files && rec.files[0]) {
    base = path.basename(path.dirname(rec.files[0]));
  } else if (rec.files && rec.files[0]) {
    // the file's own name, as embed_cover_single() uses — titles are cut in file names
    base = sanitizeForCoverMatch(path.basename(rec.files[0]).replace(/\.mp3$/i, ''));
  } else if (rec.title) {
    base = sanitizeForCoverMatch(String(rec.title).slice(0, 120));
  }
  if (!base) return null;
  const relPath = path.join('downloads', '_covers', `${base}_cover.jpg`);
  return fs.existsSync(path.join(__dirname, relPath)) ? relPath : null;
}

// Read data/download-manifest.jsonl and return the latest record per URL
// (last line wins, so re-running a download overwrites the earlier attempt).
function matchManifest(urls) {
  if (!fs.existsSync(MANIFEST_FILE)) return urls.map((u) => ({ url: u, files: [] }));
  const byUrl = new Map();
  for (const line of fs.readFileSync(MANIFEST_FILE, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      byUrl.set(rec.url, rec);
    } catch (e) {
      /* skip malformed line */
    }
  }
  return urls.map((u) => {
    const rec = byUrl.get(u) || { url: u, files: [] };
    rec.cover = coverFallback(rec);
    return rec;
  });
}

// ---------- /preview ---------------------------------------------------------
// Runs the SAME parser the live site uses (scripts/scrape-modem.js's
// parsePage, via preview.js) against a synthetic page built from the current
// draft — lets the user catch a bad embed or an unmatched artist tag before
// anything is pasted into radioštudent.
app.post('/preview', (req, res) => {
  try {
    const { items, artists, labels, showNumber, html } = req.body || {};
    const result = previewDraft({ items: items || [], artists: artists || [], labels: labels || [], showNumber: showNumber || null, html: html || null });
    res.json({ ok: true, record: result.record, warnings: result.warnings });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- /publish-check ----------------------------------------------------
// "Publish" only makes sense once the show is actually live on radioštudent
// (scrape-modem.js fetches that live page — there's nothing to scrape yet
// otherwise). Same not-found signal scrape-modem.js's own main() uses.
app.get('/publish-check', (req, res) => {
  const show = req.query.show;
  if (!show) return res.status(400).json({ ok: false, error: 'missing show number' });
  try {
    const html = curlGet(`https://radiostudent.si/glasba/modem/modem-${show}`);
    const notFound =
      /<title>\s*Stran ni bila najdena/i.test(html) ||
      /<link rel="canonical" href="https:\/\/radiostudent\.si\/"\s*\/?>/i.test(html) ||
      html.length < 500;
    res.json({ ok: true, live: !notFound });
  } catch (e) {
    res.json({ ok: true, live: false, error: String(e.message || e) });
  }
});

// ---------- /publish-compare --------------------------------------------------
// Publishing no longer reads the radioštudent page — the site is built from the
// draft — so this is the safety net: if the page is live, does it still match
// the draft? (see compare-live.js). Informational only.
app.post('/publish-compare', (req, res) => {
  const { show, items, html } = req.body || {};
  if (!show || !Array.isArray(items) || !items.length) return res.status(400).json({ ok: false, error: 'show number and a non-empty track list are required' });
  try {
    res.json({ ok: true, ...compareWithLive(String(show), items, html || null) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- cover export, kept for the site -----------------------------------
// The Covers tab's "Export PNG" also sends the image here, so publishing can put
// that exact cover on the site (add-show-from-draft.js converts it to the site's
// WebP mirror). Lives under downloads/ (gitignored, like every other download).
const SHOW_COVERS_DIR = path.join(__dirname, 'downloads', '_show_covers');
app.post('/cover-save', express.raw({ type: '*/*', limit: '40mb' }), (req, res) => {
  const show = String(req.query.show || '').trim();
  if (!/^\d+$/.test(show)) return res.status(400).json({ ok: false, error: 'a numeric show number is required' });
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ ok: false, error: 'no image data' });
  fs.mkdirSync(SHOW_COVERS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SHOW_COVERS_DIR, `modem-${show}.png`), req.body);
  res.json({ ok: true, bytes: req.body.length });
});
app.get('/cover-status', (req, res) => {
  const show = String(req.query.show || '').trim();
  if (!/^\d+$/.test(show)) return res.json({ ok: true, exists: false });
  try {
    const st = fs.statSync(path.join(SHOW_COVERS_DIR, `modem-${show}.png`));
    res.json({ ok: true, exists: true, mtime: st.mtime.toISOString() });
  } catch (e) {
    res.json({ ok: true, exists: false });
  }
});

// ---------- /publish-run (background job) + /publish-push --------------------
// Two separate steps, on purpose (confirmed with the user): /publish-run does
// everything local — build the show's record from the draft, rebuild the
// archive, rebuild docs/ — and stops at a git diff summary. Only /publish-push,
// a distinct button click, actually commits + pushes to the live site's repo.
// The same job also runs "Publish site edits" (kind 'edits', no show — the Edit
// site and SoundCloud links decisions on their own, see /publish-edits-run).
let publishJob = null; // { kind, running, done, error, log, show, diffSummary, changed }

const WEBPACK_STEP = [process.execPath, [path.join(REPO_ROOT, 'node_modules', 'webpack', 'bin', 'webpack.js'), '--config', path.join(REPO_ROOT, 'webpack.js')]];

// Tag edits saved since the last publish are applied by apply-overrides.js. If
// one of them TAKES BACK something already on the site (a merge undone, an edit
// reset), the archive no longer has the original spelling, so it's re-derived
// from source first — scrape-modem.js --reparse, bracketed by reparse-guard.js
// so nothing the pages don't carry is lost. "Since the last publish" = against
// the committed overrides.json.
function tagUndoSinceLastPublish() {
  try {
    const committed = JSON.parse(execFileSync('git', ['show', 'HEAD:src/assets/overrides.json'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    const working = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src', 'assets', 'overrides.json'), 'utf8'));
    return undoesSomething(committed, working);
  } catch (e) { return false; } // no committed copy / unreadable — nothing to take back
}

// Which shows/lists a run changed, in words — compares every record of the
// committed archive with the rebuilt one, so the review before pushing says
// "modem-247: heading 1 (artists, labels)" instead of a line count.
function describeArchiveChanges() {
  const before = JSON.parse(execFileSync('git', ['show', 'HEAD:src/assets/modem-archive.json'], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const after = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src', 'assets', 'modem-archive.json'), 'utf8'));
  const bySlug = (d) => Object.fromEntries((d.records || []).map((r) => [r.slug, r]));
  const A = bySlug(before), B = bySlug(after);
  const tagsOf = (r, field, seg) => JSON.stringify((r[field] || []).filter((t) => t.seg === seg).map((t) => t.name));
  const out = [];
  for (const slug of Object.keys(B)) {
    const a = A[slug], b = B[slug];
    if (!a) { out.push(`${slug}: new`); continue; }
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const segs = new Set([...(a.artists || []), ...(a.labels || []), ...(b.artists || []), ...(b.labels || [])].map((t) => t.seg));
    const bits = [];
    [...segs].sort((x, y) => (x == null) - (y == null) || x - y).forEach((seg) => {
      const what = ['artists', 'labels'].filter((f) => tagsOf(a, f, seg) !== tagsOf(b, f, seg));
      if (what.length) bits.push(`${seg == null ? 'tags not under a heading' : 'heading ' + (seg + 1)} (${what.join(', ')})`);
    });
    for (const f of ['title', 'date', 'cover', 'mp3', 'bodyHtml']) if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) bits.push(f);
    if (JSON.stringify(a.soundcloud) !== JSON.stringify(b.soundcloud)) bits.push('soundcloud');
    out.push(`${slug}: ${bits.length ? bits.join('; ') : 'other details'}`);
  }
  for (const slug of Object.keys(A)) if (!B[slug]) out.push(`${slug}: REMOVED`);
  // Tracks: their credits (what a tag edit changes) counted apart from the rest.
  // A rebuild on this computer also refreshes details the automatic GitHub
  // update can't fill in (it has no scripts/.cache): SoundCloud playback info,
  // fuller search text — harmless, but it would swamp the count.
  const CREDIT_FIELDS = ['title', 'artist', 'artists', 'shows'];
  const TA = Object.fromEntries((before.tracks || []).map((t) => [t.key, t]));
  const TB = Object.fromEntries((after.tracks || []).map((t) => [t.key, t]));
  let trackCredits = 0, trackDetails = 0;
  for (const k of new Set([...Object.keys(TA), ...Object.keys(TB)])) {
    const a = TA[k], b = TB[k];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    if (!a || !b || CREDIT_FIELDS.some((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]))) trackCredits++;
    else trackDetails++;
  }
  return { records: out, trackCredits, trackDetails };
}

// The two decision files as they were when a run finished — /publish-push
// refuses if they changed since (see there).
function decisionsFingerprint() {
  const read = (rel) => { try { return fs.readFileSync(path.join(REPO_ROOT, rel)); } catch (e) { return Buffer.alloc(0); } };
  return require('crypto').createHash('sha1').update(read('src/assets/overrides.json')).update('\u0000').update(read('scripts/approvals.json')).digest('hex');
}

// Run a list of [cmd, args] steps one after the other into publishJob's log,
// then stop at a summary of what changed. Nothing is committed here.
function runJob(steps) {
  (function runNext(i) {
    if (!publishJob.running) return; // a step already failed
    if (i >= steps.length) {
      try {
        const status = execFileSync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' });
        const diffStat = execFileSync('git', ['diff', '--stat'], { cwd: REPO_ROOT, encoding: 'utf8' });
        publishJob.diffSummary = (status.trim() ? status + '\n' : '(no changes)\n') + diffStat;
      } catch (e) {
        publishJob.diffSummary = 'could not compute git diff: ' + String(e.message || e);
      }
      try { publishJob.changed = describeArchiveChanges(); } catch (e) { publishJob.changed = null; }
      publishJob.decisions = decisionsFingerprint();
      publishJob.running = false;
      publishJob.done = true;
      return;
    }
    const [cmd, args] = steps[i];
    publishJob.log.push('→ ' + args.join(' ').split(/[/\\]/).pop());
    runStep(cmd, args, REPO_ROOT, (code) => {
      if (code !== 0) { publishJob.running = false; publishJob.error = args[0] + ' exited ' + code; return; }
      runNext(i + 1);
    });
  })(0);
}

function runStep(cmd, args, cwd, onDone) {
  const child = spawn(cmd, args, { cwd });
  const push = (buf) => {
    // eslint-disable-next-line no-control-regex
    String(buf).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).forEach((l) => { if (l.trim()) publishJob.log.push(l.trim()); }); // no terminal colour codes in the page's log
    if (publishJob.log.length > 500) publishJob.log = publishJob.log.slice(-500);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => { publishJob.running = false; publishJob.error = String(e.message || e); });
  child.on('close', (code) => onDone(code));
}

app.post('/publish-run', (req, res) => {
  if (publishJob && publishJob.running) return res.json({ ok: true, already: true });
  const show = String((req.body && req.body.show) || '').trim();
  if (!show) return res.status(400).json({ ok: false, error: 'missing show number' });
  if (!/^\d+$/.test(show)) return res.status(400).json({ ok: false, error: 'the show number must be a plain number' });
  const airDate = req.body.date ? String(req.body.date).trim() : null;
  if (airDate && !/^\d{1,2}\. ?\d{1,2}\. ?\d{4}$/.test(airDate)) {
    return res.status(400).json({ ok: false, error: 'the air date must look like 12. 10. 2026' });
  }

  // A show that's already on the site because it was SCRAPED from radioštudent
  // (every show before the show builder started publishing from the draft) is not
  // replaced unless the page says so explicitly — a wrong Show # shouldn't be able
  // to overwrite an old show with this draft.
  try {
    const rec = ((getArchive().records) || []).find((r) => r.slug === `modem-${show}`);
    if (rec && rec.origin !== 'show-builder' && !req.body.replace) {
      return res.status(409).json({
        ok: false, code: 'exists',
        error: `modem-${show} is already on the site (it was scraped from radioštudent).`,
      });
    }
  } catch (e) { /* archive unreadable — the pipeline will say so itself */ }

  // Refuse to start on top of SUSPICIOUS uncommitted changes — but not any
  // dirty tree at all. Every publish run legitimately leaves modem-archive.json/
  // used-tracks.json modified and a new cover under modem_covers/ (and docs/
  // once webpack runs), even if it gets interrupted right after the scrape
  // step — that's this SAME show's own in-progress output, expected and safe
  // to just build on by running again (scrape-modem.js re-scraping the same
  // show is idempotent). What's NOT safe is a stray change to something
  // unrelated (a year-end list, some other show) left over from a genuinely
  // different, earlier interrupted attempt silently getting built on top of —
  // that's the actual incident this is guarding against (a --lists bug,
  // since fixed, re-scraping best-releases-of-2025 mid an unrelated publish).
  try {
    const dirty = execFileSync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' });
    // NOT dirty.trim().split(...) — an unstaged modification's status code is
    // a LEADING SPACE (" M path"), and .trim()-ing the whole multi-line
    // string before splitting eats that space off only the first line,
    // shifting it by one character. line.slice(3) below (which strips git's
    // fixed 2-status-char + 1-space prefix) then cuts into the path itself
    // instead, so a perfectly normal first entry like " M show-builder/data/
    // used-tracks.json" silently became "how-builder/data/used-tracks.json"
    // and failed the allow-list regex — a real false-positive hit in
    // production, not just a hypothetical.
    const dirtyLines = dirty.split(/\r?\n/).filter((l) => l.length > 0);
    const suspicious = dirtyLines.filter((line) => {
      const filePath = line.slice(3);
      if (LIST_SLUG_PATTERN.test(filePath)) return true; // the exact residue pattern the incident left behind
      return !EXPECTED_DIRTY.test(filePath); // anything outside the normal per-publish set — be cautious
    });
    // modem-archive.json is ONE file covering every show AND every list —
    // its PATH is the same regardless of which record inside it actually
    // changed, so the path-only check above can never catch "this diff
    // touches an unrelated list" the way it can for other files. Check the
    // actual diff CONTENT for that one file instead — a direct, robust
    // test for the literal thing that went wrong (best-releases-of-2025
    // getting re-scraped alongside an unrelated show).
    if (dirtyLines.some((l) => /src\/assets\/modem-archive\.json$/.test(l.slice(3)))) {
      const archiveDiff = execFileSync('git', ['diff', '--', 'src/assets/modem-archive.json'], { cwd: REPO_ROOT, encoding: 'utf8' });
      if (LIST_SLUG_PATTERN.test(archiveDiff)) {
        suspicious.push('src/assets/modem-archive.json (its diff mentions a year-end list, not just the show being published)');
      }
    }
    if (suspicious.length) {
      return res.status(409).json({
        ok: false,
        error: 'The repo has uncommitted changes unrelated to a normal publish run (possibly left over from a ' +
          'different interrupted attempt). Review with "git status"/"git diff" in the repo folder, then either ' +
          'commit them if intentional or "git checkout -- <file>" to discard them — before running the pipeline again.',
        dirtyFiles: suspicious,
      });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'could not check git status: ' + String(e.message || e) });
  }

  const rederive = tagUndoSinceLastPublish();

  publishJob = { kind: 'show', running: true, done: false, error: null, log: [`publishing modem-${show}…`], show, diffSummary: null };
  const node = process.execPath;
  const script = (name, ...args) => [node, [path.join(REPO_ROOT, 'scripts', name), ...args]];
  const steps = [
    // The show's record is built straight from the draft (tracklist HTML, every
    // artist/label credit, the exported cover) with the same parser the scraper
    // uses — the radioštudent page is NOT read, so it needn't be live yet and any
    // edit made only there can't leak in. See scripts/add-show-from-draft.js.
    // (The old route — scrape-modem.js, then apply-draft-tags.js to put the
    // draft's tags over radioštudent's — still exists for shows not built here.)
    [node, [path.join(REPO_ROOT, 'scripts', 'add-show-from-draft.js'), '--show', show,
      ...(airDate ? ['--date', airDate] : []), ...(req.body.replace ? ['--replace-existing'] : [])]],
    ...(rederive ? [script('reparse-guard.js', '--snapshot'), script('scrape-modem.js', '--reparse'), script('reparse-guard.js', '--restore')] : []),
    // Carry the SoundCloud links picked in "Your show" into approvals.json —
    // must run before apply-sc-matches.js below, which is what turns
    // approvals.json into `scPlay` on the archive's tracks. No-ops when no
    // local draft matches this show number.
    [node, [path.join(REPO_ROOT, 'scripts', 'apply-draft-sc.js'), '--show', show]],
    [node, [path.join(REPO_ROOT, 'scripts', 'build-track-index.js')]],
    [node, [path.join(REPO_ROOT, 'scripts', 'apply-sc-matches.js')]],
    [node, [path.join(REPO_ROOT, 'scripts', 'apply-overrides.js')]],
    // hand-set tracklist start times (Tracklist tab) over the show's timestamps
    [node, [path.join(REPO_ROOT, 'scripts', 'tracklists', 'apply-timestamp-edits.js')]],
    WEBPACK_STEP,
  ];
  runJob(steps);
  res.json({ ok: true, started: true });
});

app.get('/publish-status', (req, res) => {
  if (!publishJob) return res.json({ running: false, done: false, log: [] });
  res.json({
    kind: publishJob.kind, show: publishJob.show || null,
    running: publishJob.running, done: publishJob.done, error: publishJob.error,
    log: publishJob.log.slice(-25), diffSummary: publishJob.diffSummary, changed: publishJob.changed || null,
  });
});

// ---------- /publish-edits-run — "Publish site edits" -------------------------
// The Edit site tab's tag edits and the SoundCloud links tab's decisions on
// their own, without a new show: the same rebuild a show publish ends with
// (re-derive only if something was taken back, track index, SoundCloud links,
// tag edits, webpack), then the same review → /publish-push. Refuses while a
// show publish is waiting to be pushed, so the two never end up in one commit.
const SHOW_PUBLISH_OUTPUT = /(^|\/)(src\/assets\/builder-shows\.json|show-builder\/data\/used-tracks\.json)$|(^|\/)src\/assets\/modem_covers\//;
app.post('/publish-edits-run', (req, res) => {
  if (publishJob && publishJob.running) return res.json({ ok: true, already: true });
  let dirtyLines;
  try {
    dirtyLines = execFileSync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' }).split(/\r?\n/).filter((l) => l.length > 0);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'could not check git status: ' + String(e.message || e) });
  }
  const files = dirtyLines.map((l) => l.slice(3)); // NOT trimmed first — see /publish-run
  if (files.some((f) => SHOW_PUBLISH_OUTPUT.test(f))) {
    return res.status(409).json({
      ok: false,
      error: 'A show publish was run but not pushed yet. Finish it first (Publish & Edit → Confirm & push) — ' +
        'it takes your saved site edits along with it.',
    });
  }
  const unrelated = files.filter((f) => !EXPECTED_DIRTY.test(f));
  if (unrelated.length) {
    return res.status(409).json({
      ok: false,
      error: 'The repo has uncommitted changes that aren\'t site edits. Commit or discard them first (git status in the repo folder).',
      dirtyFiles: unrelated,
    });
  }
  if (!files.some((f) => /(^|\/)(src\/assets\/overrides\.json|scripts\/approvals\.json)$/.test(f))) {
    return res.status(400).json({ ok: false, error: 'Nothing to publish — there are no saved tag edits or SoundCloud-link decisions that aren\'t on the site yet.' });
  }

  const rederive = tagUndoSinceLastPublish();
  publishJob = { kind: 'edits', running: true, done: false, error: null, log: ['rebuilding the site with your saved edits…'], show: null, diffSummary: null };
  if (rederive) publishJob.log.push('(an edit was taken back — re-deriving from the source pages first, protected)');
  const script = (name, ...args) => [process.execPath, [path.join(REPO_ROOT, 'scripts', name), ...args]];
  runJob([
    ...(rederive ? [script('reparse-guard.js', '--snapshot'), script('scrape-modem.js', '--reparse'), script('reparse-guard.js', '--restore')] : []),
    script('build-track-index.js'),
    script('apply-sc-matches.js'),
    script('apply-overrides.js'),
    script(path.join('tracklists', 'apply-timestamp-edits.js')),
    WEBPACK_STEP,
  ]);
  res.json({ ok: true, started: true });
});

// ---------- /show-audio + /show-audio-run — "Look for the show on SoundCloud" --------
// A show goes on the site before it airs, so its full-show SoundCloud upload comes later:
// the automatic GitHub update fills it in on Monday/Tuesday mornings
// (scripts/backfill-show-audio.js). Matej, 2026-10-25: a button to do it right away, from
// SoundCloud only ("source the tracks from soundcloud" — radioštudent's mp3 stays with that
// update). /show-audio only looks (the same lookup, `--check`); /show-audio-run fills it in
// and rebuilds the site, then the usual review → Confirm & push.
app.get('/show-audio', (req, res) => {
  const show = String(req.query.show || '').trim();
  if (!/^\d+$/.test(show)) return res.status(400).json({ ok: false, error: 'the show number must be a plain number' });
  const args = [path.join(REPO_ROOT, 'scripts', 'backfill-show-audio.js'), '--show', show, '--check'];
  execFile(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    let found = null;
    try { found = JSON.parse(String(stdout).split('\n').filter((l) => l.startsWith('{')).pop()); } catch (e) { /* below */ }
    if (!found) return res.status(500).json({ ok: false, error: 'the lookup failed: ' + String(stderr || (err && err.message) || stdout).slice(-500) });
    // not at the address the site looks for: what IS on the account, newest first
    if (!found.soundcloud) {
      try { found.latest = scanSoundcloud.latestUploads(4); } catch (e) { found.latest = null; }
    }
    res.json({ ok: true, ...found });
  });
});

app.post('/show-audio-run', (req, res) => {
  if (publishJob && publishJob.running) return res.json({ ok: true, already: true });
  const show = String((req.body && req.body.show) || '').trim();
  if (!/^\d+$/.test(show)) return res.status(400).json({ ok: false, error: 'the show number must be a plain number' });
  let files;
  try {
    files = execFileSync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' }).split(/\r?\n/).filter((l) => l.length > 0).map((l) => l.slice(3)); // NOT trimmed first — see /publish-run
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'could not check git status: ' + String(e.message || e) });
  }
  if (files.some((f) => SHOW_PUBLISH_OUTPUT.test(f))) {
    return res.status(409).json({ ok: false, error: 'A show publish was run but not pushed yet. Finish it first (Confirm & push above), then look again.' });
  }
  const unrelated = files.filter((f) => !EXPECTED_DIRTY.test(f));
  if (unrelated.length) {
    return res.status(409).json({ ok: false, error: 'The repo has uncommitted changes that aren\'t a normal publish. Commit or discard them first (git status in the repo folder).', dirtyFiles: unrelated });
  }
  // site edits saved but not published yet go along — a push would commit them anyway, so
  // they're built into the site too (the review lists them)
  const withEdits = files.some((f) => /(^|\/)(src\/assets\/overrides\.json|scripts\/approvals\.json)$/.test(f));
  const rederive = withEdits && tagUndoSinceLastPublish();
  publishJob = { kind: 'audio', running: true, done: false, error: null, log: [`modem-${show}: putting the full-show SoundCloud player on the site…`], show, withEdits, diffSummary: null };
  if (withEdits) publishJob.log.push('(your saved site edits that aren\'t on the site yet go along)');
  const script = (name, ...args) => [process.execPath, [path.join(REPO_ROOT, 'scripts', name), ...args]];
  runJob([
    script('backfill-show-audio.js', '--show', show),
    ...(withEdits ? [
      ...(rederive ? [script('reparse-guard.js', '--snapshot'), script('scrape-modem.js', '--reparse'), script('reparse-guard.js', '--restore')] : []),
      script('build-track-index.js'),
      script('apply-sc-matches.js'),
      script('apply-overrides.js'),
      script(path.join('tracklists', 'apply-timestamp-edits.js')),
    ] : []),
    WEBPACK_STEP,
  ]);
  res.json({ ok: true, started: true });
});

// ---------- /publish-discard — throw away an unpushed "Publish site edits" build
// (or a show-audio one). Puts the site's archive and docs/ back to the last commit. The
// saved edits themselves (overrides.json, approvals.json) stay, ready for the next run.
app.post('/publish-discard', (req, res) => {
  if (publishJob && publishJob.running) return res.status(409).json({ ok: false, error: 'a run is still going' });
  if (publishJob && !['edits', 'audio'].includes(publishJob.kind)) return res.status(409).json({ ok: false, error: 'only a "Publish site edits" or show-audio build can be discarded here' });
  try {
    const files = execFileSync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' }).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
    if (files.some((f) => SHOW_PUBLISH_OUTPUT.test(f))) return res.status(409).json({ ok: false, error: 'a show publish is waiting to be pushed — not touching it' });
    execFileSync('git', ['checkout', '--', 'src/assets/modem-archive.json', 'src/assets/show-timestamps.json', 'docs'], { cwd: REPO_ROOT, encoding: 'utf8' });
    publishJob = null;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/publish-push', (req, res) => {
  if (!publishJob || !publishJob.done) return res.status(400).json({ ok: false, error: 'run the publish pipeline first' });
  const show = publishJob.show;
  const audio = publishJob.kind === 'audio';
  const edits = publishJob.kind === 'edits' || (audio && publishJob.withEdits);
  try {
    // The "Review before pushing" box only ever showed `git diff --stat` —
    // line-count totals, not content — so a human glancing at it has no real
    // way to tell "big diff because the tracks array re-sorted" apart from
    // "big diff because it touched something unrelated." Actually check the
    // content of the one shared file where that distinction matters, right
    // before it goes live, instead of trusting the stat alone.
    // (Not for a site-edits run: a tag merge legitimately renames a tag on a
    // year-end list too — its review lists every changed show/list by name.)
    const archiveDiff = edits ? '' : execFileSync('git', ['diff', '--', 'src/assets/modem-archive.json'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (LIST_SLUG_PATTERN.test(archiveDiff)) {
      return res.status(409).json({
        ok: false,
        error: 'src/assets/modem-archive.json\'s diff mentions a year-end list, not just modem-' + show +
          '. Refusing to push — review "git diff -- src/assets/modem-archive.json" in the repo folder first.',
      });
    }
    // Edits saved (or brought in by Sync) after the run finished aren't in the
    // rebuilt site — pushing now would put them in the commit but not on the page.
    if (publishJob.decisions && publishJob.decisions !== decisionsFingerprint()) {
      return res.status(409).json({ ok: false, error: 'Edits were saved after this run finished, so they aren\'t in it. Run it again, then push.' });
    }
    execFileSync('git', ['add', '-A'], { cwd: REPO_ROOT });
    const status = execFileSync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (!status.trim()) return res.json({ ok: true, pushed: false, message: 'nothing to commit' });
    const message = audio ? `modem-${show}: full-show SoundCloud player${publishJob.withEdits ? ' + site edits' : ''} via show-builder [skip ci]`
      : edits ? 'Site edits (tags / SoundCloud links) via show-builder [skip ci]' : `Publish modem-${show} via show-builder [skip ci]`;
    execFileSync('git', ['commit', '-m', message], { cwd: REPO_ROOT, encoding: 'utf8' });
    const log = execFileSync('git', ['push'], { cwd: REPO_ROOT, encoding: 'utf8' });
    publishJob = null; // require a fresh /publish-run before another push is allowed
    res.json({ ok: true, pushed: true, log });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ---------- /open-covers-folder -----------------------------------------------
// Opens downloads/_covers in the OS file browser — a fixed local path, not
// influenced by request data, so passing it to a shell command is safe.
app.post('/open-covers-folder', (req, res) => {
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const cmd = process.platform === 'win32' ? `explorer "${COVERS_DIR}"`
    : process.platform === 'darwin' ? `open "${COVERS_DIR}"`
    : `xdg-open "${COVERS_DIR}"`;
  // explorer.exe reports a non-zero exit code even on success — ignore it,
  // this is best-effort UI convenience either way.
  exec(cmd, () => {});
  res.json({ ok: true, path: COVERS_DIR });
});

// ---------- /generate --------------------------------------------------------
app.post('/generate', (req, res) => {
  const items = (req.body && req.body.items) || [];
  if (!items.length) return res.status(400).json({ ok: false, error: 'no items given' });
  try {
    const html = generateShowHtml(items);
    const used = new Set(readJson(USED_FILE, []));
    items.forEach((it) => used.add(it.key));
    writeJson(USED_FILE, [...used]);
    res.json({ ok: true, html });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

const PORT = process.env.PORT || 8090;
app.listen(PORT, () => console.log(`show-builder running at http://localhost:${PORT}`));
