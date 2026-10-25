#!/usr/bin/env node
/*
 * backup-shows.js — a copy of every aired show's recording in the backup folder
 * (D:/MODEM/oddaje, files named Modem_NNN_YYYY-MM-DD.mp3 by air date). They are radioštudent's
 * own 320 kbps broadcast recordings: the folder's files for 1–218 are byte-identical to them
 * (checked on 218, 2026-10-25). Matej, 2026-10-25: "make it a habit of backing up all of the
 * modem shows to that folder".
 *
 * Every show in the archive whose recording isn't in the folder yet is downloaded: from its
 * `mp3` (the Monday/Tuesday update fills it in once the show has aired) or, while that's still
 * empty, from the address radioštudent gives it (YYYY-MM-DD-modem-modem-N.mp3 by air date) if
 * that answers. It goes to a .part file first and is renamed only when its size is the one
 * the server said, so a cut-off download never looks like a backup. One at a time.
 * Does nothing when the folder isn't there (the Surface has no D:).
 *
 *   node scripts/backup-shows.js           back up what's missing
 *   node scripts/backup-shows.js --check   only list what's missing
 * The show builder runs it in the background when it starts (show-builder/server.js);
 * MODEM_BACKUP_DIR points it at another folder.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIR = process.env.MODEM_BACKUP_DIR || 'D:/MODEM/oddaje';
const CHECK = process.argv.includes('--check');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
const LOCK = path.join(DIR, '.backup-shows.lock');

if (!fs.existsSync(DIR)) {
  console.log(`backup-shows: no backup folder on this computer (${DIR}) — nothing to do.`);
  process.exit(0);
}

const pad3 = (n) => String(n).padStart(3, '0');
// "12. 10. 2026" → "2026-10-12"
const isoOf = (date) => {
  const m = String(date || '').match(/^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
};

// The size the server gives a file (after redirects), or null when it doesn't answer with one.
function remoteSize(url) {
  try {
    const head = execFileSync('curl', ['-sS', '-L', '-I', '--max-time', '30', '-A', UA, url], { encoding: 'utf8' });
    const blocks = head.trim().split(/\r?\n\r?\n/);
    const last = blocks[blocks.length - 1];
    if (!/^HTTP\/\S+ 200/m.test(last)) return null;
    const len = (last.match(/^content-length:\s*(\d+)/im) || [])[1];
    const type = (last.match(/^content-type:\s*(\S+)/im) || [])[1] || '';
    return len && /audio|mpeg|octet-stream/i.test(type) ? Number(len) : null;
  } catch (e) {
    return null;
  }
}

const archive = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'assets', 'modem-archive.json'), 'utf8'));
const have = new Set(fs.readdirSync(DIR).map((f) => (f.match(/^Modem_(\d{3})_/i) || [])[1]).filter(Boolean).map(Number));
const today = new Date().toISOString().slice(0, 10);
const missing = [];
for (const r of archive.records) {
  const n = Number(r.number);
  if (r.type !== 'show' || !n || have.has(n)) continue;
  const iso = isoOf(r.date);
  let url = r.mp3 || null;
  if (!url && iso && iso < today) url = `https://radiostudent.si/sites/default/files/posnetki/modem/${iso}-modem-modem-${n}.mp3`;
  if (!url) continue; // not aired yet
  const day = (url.match(/\/(\d{4}-\d{2}-\d{2})-modem/) || [])[1] || iso;
  missing.push({ n, url, guessed: !r.mp3, name: `Modem_${pad3(n)}_${day || 'unknown'}.mp3` });
}
missing.sort((a, b) => a.n - b.n);

if (!missing.length) {
  console.log(`backup-shows: every aired show is in ${DIR}.`);
  process.exit(0);
}
if (CHECK) {
  console.log(`backup-shows: ${missing.length} show(s) not in ${DIR}:\n  ` + missing.map((m) => `${m.name}  ← ${m.url}${m.guessed ? ' (address guessed)' : ''}`).join('\n  '));
  process.exit(0);
}

// one run at a time (the builder may be started twice); a lock older than 3 hours is stale
try {
  const st = fs.statSync(LOCK);
  if (Date.now() - st.mtimeMs < 3 * 3600 * 1000) { console.log('backup-shows: another backup run is going — skipping.'); process.exit(0); }
} catch (e) { /* no lock */ }
fs.writeFileSync(LOCK, `${process.pid} ${new Date().toISOString()}\n`);

let ok = 0;
const failed = [];
try {
  for (const m of missing) {
    const size = remoteSize(m.url);
    if (!size) { failed.push(`${m.name}: no recording at ${m.url} yet`); continue; }
    const part = path.join(DIR, m.name + '.part');
    try {
      execFileSync('curl', ['-sS', '-L', '--fail', '--retry', '3', '--max-time', '3600', '-A', UA, '-o', part, m.url], { stdio: ['ignore', 'ignore', 'pipe'] });
      const got = fs.statSync(part).size;
      if (got !== size) throw new Error(`got ${got} bytes, the server said ${size}`);
      fs.renameSync(part, path.join(DIR, m.name));
      ok++;
      console.log(`backup-shows: ${m.name} (${Math.round(size / 1048576)} MB)`);
    } catch (e) {
      try { fs.unlinkSync(part); } catch (e2) { /* nothing written */ }
      failed.push(`${m.name}: ${String(e.stderr || e.message || e).trim().slice(0, 200)}`);
    }
  }
} finally {
  try { fs.unlinkSync(LOCK); } catch (e) { /* already gone */ }
}
console.log(`backup-shows: ${ok} backed up${failed.length ? `, ${failed.length} not:\n  ` + failed.join('\n  ') : ''}.`);
