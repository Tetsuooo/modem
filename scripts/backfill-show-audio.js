/*
 * backfill-show-audio.js — fill in the full-episode player (radiostudent mp3 +
 * SoundCloud upload) on recent shows that were added to the archive before
 * the show aired. show-builder publishes a show as soon as its radiostudent
 * page is up, which is before the broadcast mp3 and the SoundCloud upload
 * exist, so the record lands with mp3/soundcloud = null, and nothing re-scrapes
 * an already-archived show. This patches ONLY those two fields in place; a full
 * re-scrape would also overwrite the draft-sourced artist/label tags and any
 * admin segment edits.
 *
 * Only the most recent shows are checked (a few old shows legitimately have no
 * mp3 or SoundCloud upload). Exits 0 either way; writes the archive only if
 * something was filled in. `node scripts/backfill-show-audio.js [--recent N]`
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { resolveSoundcloud, findMp3 } = require('./scrape-modem.js');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const argv = process.argv.slice(2);
const i = argv.indexOf('--recent');
const RECENT = i >= 0 ? Number(argv[i + 1]) : 6;

const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const recent = d.records
  .filter((r) => r.type === 'show' && Number(r.number))
  .sort((a, b) => Number(b.number) - Number(a.number))
  .slice(0, RECENT)
  .filter((r) => !r.mp3 || !r.soundcloud);

if (!recent.length) {
  console.log(`backfill: the ${RECENT} most recent shows all have mp3 + SoundCloud.`);
  process.exit(0);
}

let changed = 0;
for (const r of recent) {
  const got = [];
  if (!r.mp3) {
    try {
      const html = execFileSync('curl', ['-sSL', '--max-time', '40', '-A', UA, r.url], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
      });
      const mp3 = findMp3(html);
      if (mp3) { r.mp3 = mp3; got.push('mp3'); }
    } catch (e) {
      console.warn(`  ! ${r.slug}: radiostudent fetch failed: ${e.message}`);
    }
  }
  if (!r.soundcloud) {
    const sc = resolveSoundcloud(Number(r.number), { hit: false });
    if (sc) { r.soundcloud = sc; got.push('soundcloud'); }
  }
  const still = [!r.mp3 && 'mp3', !r.soundcloud && 'soundcloud'].filter(Boolean);
  console.log(
    `  ${r.slug}: ` +
      (got.length ? 'filled ' + got.join(' + ') : 'nothing new') +
      (still.length ? ' (still missing: ' + still.join(', ') + ')' : '')
  );
  if (got.length) changed++;
}

if (changed) {
  d.counts.withSoundcloud = d.records.filter((r) => r.soundcloud).length;
  fs.writeFileSync(DATA, JSON.stringify(d, null, 2));
  console.log(`backfill: updated ${changed} show(s) → ${path.relative(ROOT, DATA)}`);
} else {
  console.log('backfill: no changes.');
}
