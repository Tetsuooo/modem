/*
 * auto-confirm-matches.js — auto-approve the "review" Bandcamp→SoundCloud matches
 * that are near-certain: a duration-matched candidate (±2s) whose COVER ART matches
 * the Bandcamp cover (perceptual dHash Hamming distance ≤ threshold).
 *
 * Why: the finder leaves title-exact + duration-exact matches in `review` only
 * because the SoundCloud uploader is the label/a renamer, not the artist. Same cover
 * + same length = same track, so the cover hash safely confirms these (a clean gap
 * separates real matches at ≤12 from different-cover non-matches at 21+).
 *
 * Writes each confirmation to scripts/approvals.json (the DURABLE store that
 * apply-sc-matches.js reads) and promotes the entry to tier:'auto' in
 * sc-match-candidates.json so the regenerated review page (gen-review.js) drops it
 * from the manual queue. NEVER overwrites an existing human decision.
 *
 * Requires ImageMagick (`magick`) on PATH. Cached covers live in scripts/.cache/art.
 * Re-runnable + resumable. Usage: node scripts/auto-confirm-matches.js [--threshold 8] [--dry]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const CAND = path.join(DIR, 'sc-match-candidates.json');
const APPROVALS = path.join(DIR, 'approvals.json');
const LOG = path.join(DIR, 'auto-confirm-log.json');
const ART = path.join(DIR, '.cache', 'art');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const args = process.argv.slice(2);
const THRESH = (() => { const i = args.indexOf('--threshold'); return i > -1 ? Number(args[i + 1]) : 8; })();
const DUR_TOL = 2;   // seconds
const DRY = args.includes('--dry');

const norm = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
fs.mkdirSync(ART, { recursive: true });

function cacheFile(url) { return path.join(ART, url.replace(/[^\w.-]/g, '_').slice(-80)); }
function download(url) {
  if (!url) return null;
  const f = cacheFile(url);
  if (fs.existsSync(f) && fs.statSync(f).size > 100) return f;
  try { execFileSync('curl', ['-sSL', '--max-time', '20', '-A', UA, '-o', f, url]); } catch (e) { return null; }
  return fs.existsSync(f) && fs.statSync(f).size > 100 ? f : null;
}
// dHash: 9x8 grayscale, compare adjacent columns → 64-bit string
const HC = {};
function dhash(url) {
  if (url in HC) return HC[url];
  const f = download(url);
  let h = null;
  if (f) try {
    const out = execFileSync('magick', [f, '-resize', '9x8!', '-colorspace', 'Gray', '-depth', '8', 'txt:'], { encoding: 'utf8', maxBuffer: 1e7 });
    const px = {};
    out.split('\n').forEach((l) => { const m = l.match(/^(\d+),(\d+):.*?\((\d+)/); if (m) px[m[1] + ',' + m[2]] = +m[3]; });
    let bits = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += (px[x + ',' + y] > px[(x + 1) + ',' + y] ? '1' : '0');
    if (bits.length === 64) h = bits;
  } catch (e) {}
  HC[url] = h;
  return h;
}
const ham = (a, b) => { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; };

const raw = JSON.parse(fs.readFileSync(CAND, 'utf8'));
const isArr = Array.isArray(raw);
const entries = isArr ? raw : Object.values(raw).filter((x) => x && x.key);
const approvals = fs.existsSync(APPROVALS) ? JSON.parse(fs.readFileSync(APPROVALS, 'utf8')) : {};

let considered = 0, confirmed = 0, skippedDecided = 0, noDurCand = 0, coverMiss = 0;
const log = [];
let n = 0;
for (const e of entries) {
  if (e.tier !== 'review') continue;
  if (e.key in approvals) { skippedDecided++; continue; }   // respect existing human/prior decisions
  if (!e.bcArt || !e.bcDuration) continue;
  const near = (e.candidates || []).filter((c) => c.artwork && c.duration && Math.abs(e.bcDuration - c.duration) <= DUR_TOL);
  if (!near.length) { noDurCand++; continue; }
  considered++;
  const hb = dhash(e.bcArt);
  if (!hb) { coverMiss++; continue; }
  let best = null;
  for (const c of near.slice(0, 3)) {
    const hc = dhash(c.artwork);
    if (!hc) continue;
    const d = ham(hb, hc);
    if (!best || d < best.dist) best = { c, dist: d };
  }
  if (!best) { coverMiss++; continue; }
  if (best.dist <= THRESH) {
    confirmed++;
    approvals[e.key] = best.c.id;
    e.tier = 'auto'; e.suggest = best.c.id; e.autoConfirm = { by: 'cover-hash', dist: best.dist, durDelta: Math.abs(e.bcDuration - best.c.duration) };
    log.push({ key: e.key, id: best.c.id, dist: best.dist, bcTitle: e.bcTitle, scTitle: best.c.title, scUser: best.c.user, titleExact: norm(best.c.title) === norm(e.bcTitle) });
  }
  if (++n % 100 === 0) process.stderr.write(n + ' ');
}

console.log('\n\n=== auto-confirm-matches (threshold ≤' + THRESH + ', dur ±' + DUR_TOL + 's) ===');
console.log('review entries considered (dur-close + cover):', considered);
console.log('CONFIRMED:', confirmed);
console.log('  of which title also exact:', log.filter((l) => l.titleExact).length);
console.log('  of which title differs (label/renamed):', log.filter((l) => !l.titleExact).length);
console.log('skipped (already decided):', skippedDecided, '| no dur-close candidate:', noDurCand, '| cover unavailable:', coverMiss);

if (DRY) { console.log('\n--dry: nothing written.'); process.exit(0); }

fs.writeFileSync(APPROVALS, JSON.stringify(approvals, null, 2));
fs.writeFileSync(CAND, JSON.stringify(raw));
fs.writeFileSync(LOG, JSON.stringify(log, null, 1));
console.log('\nwrote', Object.keys(approvals).length, 'total approvals →', path.relative(process.cwd(), APPROVALS));
console.log('promoted', confirmed, 'entries to tier:auto in candidates; audit log →', path.relative(process.cwd(), LOG));
console.log('next: node scripts/gen-review.js  (refresh queue)  &&  node scripts/apply-sc-matches.js  (apply to site)');
