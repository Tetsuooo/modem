// Local show-builder tool: scan SoundCloud reposts + Bandcamp wishlist/library
// for anything from the last N days, pick tracks, download them (reusing
// modem_download.py as-is), drag into order, generate the tracklist HTML to
// paste into radioštudent. Standalone from the main site's server.js/:8085 —
// own port, own process, nothing here touches the live site.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync, exec } = require('child_process');

const scanSoundcloud = require('./scan-soundcloud');
const scanBandcamp = require('./scan-bandcamp');
const { generateShowHtml } = require('./generate-html');
const { previewDraft } = require('./preview');
const { curlGet } = require('./lib');
const { checkDuplicate } = require('./duplicate-check');

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
// resolve. SoundCloud playlists don't, since resolving them costs extra
// requests only worth paying when a row is actually expanded.
app.post('/release-tracks', (req, res) => {
  const item = (req.body && req.body.item) || {};
  try {
    const isSc = item.source === 'soundcloud';
    const tracks = isSc ? scanSoundcloud.resolveTracks(item) : (item.tracks || []);
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

// ---------- draft persistence ----------------------------------------------
app.get('/draft', (req, res) => {
  res.json(readJson(DRAFT_FILE, { selected: [], order: [], generatedHtml: null }));
});
app.post('/draft', (req, res) => {
  writeJson(DRAFT_FILE, req.body || {});
  res.json({ ok: true });
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
  return urls.map((u) => byUrl.get(u) || { url: u, files: [] });
}

// ---------- /preview ---------------------------------------------------------
// Runs the SAME parser the live site uses (scripts/scrape-modem.js's
// parsePage, via preview.js) against a synthetic page built from the current
// draft — lets the user catch a bad embed or an unmatched artist tag before
// anything is pasted into radioštudent.
app.post('/preview', (req, res) => {
  try {
    const { items, artists, labels, showNumber } = req.body || {};
    const result = previewDraft({ items: items || [], artists: artists || [], labels: labels || [], showNumber: showNumber || null });
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

// ---------- /publish-run (background job) + /publish-push --------------------
// Two separate steps, on purpose (confirmed with the user): /publish-run does
// everything local — scrape the now-live page, rebuild the archive, rebuild
// docs/ — and stops at a git diff summary. Only /publish-push, a distinct
// button click, actually commits + pushes to the live site's repo.
let publishJob = null; // { running, done, error, log, show, diffSummary }

function runStep(cmd, args, cwd, onDone) {
  const child = spawn(cmd, args, { cwd });
  const push = (buf) => {
    String(buf).split(/\r?\n/).forEach((l) => { if (l.trim()) publishJob.log.push(l.trim()); });
    if (publishJob.log.length > 500) publishJob.log = publishJob.log.slice(-500);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => { publishJob.running = false; publishJob.error = String(e.message || e); });
  child.on('close', (code) => onDone(code));
}

app.post('/publish-run', (req, res) => {
  if (publishJob && publishJob.running) return res.json({ ok: true, already: true });
  const show = req.body && req.body.show;
  if (!show) return res.status(400).json({ ok: false, error: 'missing show number' });

  publishJob = { running: true, done: false, error: null, log: [`publishing modem-${show}…`], show, diffSummary: null };
  const node = process.execPath;
  const steps = [
    [node, [path.join(REPO_ROOT, 'scripts', 'scrape-modem.js'), '--shows', `${show}-${show}`]],
    [node, [path.join(REPO_ROOT, 'scripts', 'build-track-index.js')]],
    [node, [path.join(REPO_ROOT, 'scripts', 'apply-sc-matches.js')]],
    [node, [path.join(REPO_ROOT, 'scripts', 'apply-overrides.js')]],
    [node, [path.join(REPO_ROOT, 'node_modules', 'webpack', 'bin', 'webpack.js'), '--config', path.join(REPO_ROOT, 'webpack.js')]],
  ];
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

  res.json({ ok: true, started: true });
});

app.get('/publish-status', (req, res) => {
  if (!publishJob) return res.json({ running: false, done: false, log: [] });
  res.json({
    running: publishJob.running, done: publishJob.done, error: publishJob.error,
    log: publishJob.log.slice(-25), diffSummary: publishJob.diffSummary,
  });
});

app.post('/publish-push', (req, res) => {
  if (!publishJob || !publishJob.done) return res.status(400).json({ ok: false, error: 'run the publish pipeline first' });
  const show = publishJob.show;
  try {
    execFileSync('git', ['add', '-A'], { cwd: REPO_ROOT });
    const status = execFileSync('git', ['status', '--short'], { cwd: REPO_ROOT, encoding: 'utf8' });
    if (!status.trim()) return res.json({ ok: true, pushed: false, message: 'nothing to commit' });
    execFileSync('git', ['commit', '-m', `Publish modem-${show} via show-builder [skip ci]`], { cwd: REPO_ROOT, encoding: 'utf8' });
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
