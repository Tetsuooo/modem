// Uncommitted changes that stop a publish: list them, show them, commit them or put them
// back, all from the page (Matej, 2026-11-08: "address them from the interface"; three code
// files left uncommitted on the Surface had stopped show 251's publish the day before).
//
// The publish routes in server.js won't start on top of changes they didn't make (see
// /publish-run). Their refusal now carries `changes` (unexpected() below), and the page
// (public/repo-changes.js) offers, per file:
//   show      the diff
//   commit    builder code, scripts and other repo files; never a publish run's own output
//   put back  back to the last commit. A copy goes to data/.cache/put-back/ first.
// Nothing here pushes. A commit goes to GitHub with the next Confirm & push or Sync.
// health.js's first row uses uncommittedCode() to warn before a publish runs into them.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(__dirname, 'data', '.cache', 'put-back');
const KEEP_BACKUPS = 30;

// What a publish run itself changes (and Sync's own files): never "unexpected" for a run,
// and never committed from here. Moved here from server.js, unchanged.
const EXPECTED_DIRTY = /(^|\/)(src\/assets\/modem-archive\.json|show-builder\/data\/used-tracks\.json|scripts\/approvals\.json|src\/assets\/overrides\.json|src\/assets\/builder-shows\.json|src\/assets\/show-timestamps\.json)$|(^|\/)(src\/assets\/modem_covers\/|docs\/)|(^|\/)show-builder\/data\/(year-end|shared-draft|show-history)\.json$/;
const LIST_SLUG_PATTERN = /best-releases|best-labels|best-videos|best-of-|community-lists/i;
// the builder's own code or the scripts it runs (the same test as health.js's restart check)
const CODE_FILE = /^(show-builder\/(?!data\/)|scripts\/|package(-lock)?\.json$)/;

const isOutput = (f) => EXPECTED_DIRTY.test(f) || LIST_SLUG_PATTERN.test(f);
const kindOf = (f) => (isOutput(f) ? 'output' : CODE_FILE.test(f) ? 'code' : 'other');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024, ...opts });
}

// Every uncommitted change: path → git's two status letters ('??' = new, ' M', 'A ', ' D'…).
// -z: paths exactly as they are (no quoting of spaces or accents). A new folder stays one
// entry ("dir/"), as in `git status --short`.
function listChanges() {
  const parts = git(['status', '--porcelain=v1', '-z']).split('\0');
  const m = new Map();
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    m.set(e.slice(3), xy);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // a rename's old path follows; not a change of its own
  }
  return m;
}

const inHead = (f) => { try { git(['cat-file', '-e', `HEAD:${f}`]); return true; } catch (e) { return false; } };

function statusWord(xy, f) {
  if (xy === '??') return f.endsWith('/') ? 'new folder' : 'new file';
  if (xy.includes('D')) return 'deleted';
  if (xy[0] === 'R') return 'renamed';
  if (xy[0] === 'A') return 'new file';
  return 'changed';
}

// lines added / removed (null for a folder or a binary file)
function lineCounts(f, xy) {
  try {
    if (xy === '??') {
      if (f.endsWith('/')) return [null, null];
      const buf = fs.readFileSync(path.join(REPO_ROOT, f));
      if (buf.includes(0)) return [null, null];
      return [buf.toString('utf8').split('\n').length, 0];
    }
    const [a, r] = git(['diff', '--numstat', 'HEAD', '--', f]).split('\t');
    return a === '-' ? [null, null] : [Number(a) || 0, Number(r) || 0];
  } catch (e) {
    return [null, null];
  }
}

// The uncommitted changes `pick(path)` is true for, plus the ones in `notes` (path → why it
// is listed although the path alone looks fine), described for the page. Never throws: null
// = couldn't tell, and the page falls back to the plain file list.
function unexpected(pick, notes = {}) {
  try {
    const out = [];
    for (const [file, xy] of listChanges()) {
      if (!pick(file) && !notes[file]) continue;
      const [added, removed] = lineCounts(file, xy);
      out.push({ file, status: statusWord(xy, file), kind: kindOf(file), note: notes[file] || null, added, removed });
    }
    return out;
  } catch (e) {
    return null;
  }
}

// Builder code changed on this computer and not committed (a publish output such as
// scripts/approvals.json doesn't count: it's meant to wait for the next publish).
function uncommittedCode() {
  return [...listChanges().keys()].filter((f) => kindOf(f) === 'code');
}

// Only paths that are uncommitted changes right now (anything else is refused).
function checkFiles(files) {
  if (!Array.isArray(files) || !files.length || files.some((f) => typeof f !== 'string')) throw new Error('no files given');
  const now = listChanges();
  const gone = files.filter((f) => !now.has(f));
  if (gone.length) throw new Error(`not an uncommitted change (any more?): ${gone.join(', ')} — reload the list`);
  return now;
}

function diffOf(file) {
  const now = checkFiles([file]);
  const xy = now.get(file);
  const LIMIT = 200 * 1024;
  let text;
  if (xy === '??') {
    const full = path.join(REPO_ROOT, file);
    if (file.endsWith('/')) {
      const list = fs.readdirSync(full, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
        .map((d) => path.relative(REPO_ROOT, path.join(d.parentPath || d.path, d.name)).replace(/\\/g, '/'));
      text = `A new folder with ${list.length} file(s):\n` + list.slice(0, 200).join('\n');
    } else {
      const buf = fs.readFileSync(full);
      text = buf.includes(0) ? `A new file (not text, ${buf.length} bytes).` : 'A new file:\n\n' + buf.toString('utf8');
    }
  } else {
    text = git(['diff', 'HEAD', '--', file]) || '(no differences in the text: only the line endings or the file mode changed)';
  }
  return text.length > LIMIT ? text.slice(0, LIMIT) + `\n\n… (cut here: ${Math.round(text.length / 1024)} KB in all)` : text;
}

function commit(files) {
  checkFiles(files);
  const outputs = files.filter(isOutput);
  if (outputs.length) throw new Error(`${outputs.join(', ')}: made by a publish run, so it goes with that run's Confirm & push (or put it back), not committed on its own`);
  const code = files.every((f) => kindOf(f) === 'code');
  const message = `${code ? 'show-builder: code' : 'Changes'} left uncommitted on ${os.hostname()}, committed from the builder\n\n` +
    files.map((f) => `- ${f}`).join('\n') + '\n';
  git(['add', '-A', '--', ...files]);
  // only these paths, even if something else happens to be staged
  git(['commit', '-q', '-F', '-', '--', ...files], { input: message });
  return git(['rev-parse', '--short', 'HEAD']).trim();
}

function putBack(files) {
  const now = checkFiles(files);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(BACKUP_DIR, stamp);
  fs.mkdirSync(dir, { recursive: true });
  // the changes as a patch (git apply brings them back) and each file as it was
  const tracked = files.filter((f) => now.get(f) !== '??');
  if (tracked.length) fs.writeFileSync(path.join(dir, 'changes.patch'), git(['diff', '--binary', 'HEAD', '--', ...tracked]));
  for (const f of files) {
    const src = path.join(REPO_ROOT, f);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(dir, 'files', f), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'README.txt'), `Put back from the show builder on ${new Date().toString()}:\n${files.join('\n')}\n\n` +
    'files/ = each file as it was. changes.patch = the changes to files git already knew (in the repo folder: git apply <this folder>/changes.patch).\n');
  for (const f of files) {
    const xy = now.get(f);
    if (xy === '??') {
      fs.rmSync(path.join(REPO_ROOT, f), { recursive: true, force: true });
    } else if (inHead(f)) {
      git(['checkout', 'HEAD', '--', f]); // the committed version, in the file and in git's index
    } else {
      git(['rm', '-q', '--cached', '-f', '--', f]); // added but never committed: drop it
      fs.rmSync(path.join(REPO_ROOT, f), { recursive: true, force: true });
    }
  }
  prune();
  return path.relative(REPO_ROOT, dir).replace(/\\/g, '/');
}

function prune() {
  try {
    const dirs = fs.readdirSync(BACKUP_DIR).sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - KEEP_BACKUPS))) fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true, force: true });
  } catch (e) { /* nothing to prune */ }
}

// `isBusy()`: a publish run is going; nothing may change under it
function mount(app, { isBusy = () => false } = {}) {
  const guard = (res) => (isBusy() ? res.status(409).json({ ok: false, error: 'a publish run is going — wait for it to finish' }) : null);
  app.get('/repo-changes/diff', (req, res) => {
    try { res.json({ ok: true, diff: diffOf(String(req.query.file || '')) }); } catch (e) { res.status(400).json({ ok: false, error: String(e.message || e) }); }
  });
  app.post('/repo-changes/commit', (req, res) => {
    if (guard(res)) return;
    try { res.json({ ok: true, commit: commit(req.body && req.body.files) }); } catch (e) { res.status(400).json({ ok: false, error: String(e.stderr || e.message || e).trim() }); }
  });
  app.post('/repo-changes/put-back', (req, res) => {
    if (guard(res)) return;
    try { res.json({ ok: true, backup: putBack(req.body && req.body.files) }); } catch (e) { res.status(400).json({ ok: false, error: String(e.stderr || e.message || e).trim() }); }
  });
}

module.exports = { EXPECTED_DIRTY, LIST_SLUG_PATTERN, CODE_FILE, unexpected, uncommittedCode, commit, mount };
