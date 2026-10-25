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
 * something was filled in. `node scripts/backfill-show-audio.js [--recent N | --show N [--check]]`
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
// show-builder's "Look for the show on SoundCloud" (Publish tab), for one show and only its
// SoundCloud upload — radioštudent's mp3 is left to this script's scheduled run (Matej,
// 2026-10-25: "source the tracks from soundcloud"):
//   --show N           only show N's SoundCloud upload, instead of both on the recent ones
//   --show N --check   change nothing: print one JSON line with whether the site has show N's
//                      SoundCloud player and whether the upload is there now
const s = argv.indexOf('--show');
const ONLY = s >= 0 ? Number(argv[s + 1]) : null;
const CHECK = argv.includes('--check');

const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));

if (CHECK) {
  if (!ONLY) { console.error('--check needs --show N'); process.exit(1); }
  const rec = d.records.find((r) => r.type === 'show' && Number(r.number) === ONLY) || null;
  console.log(JSON.stringify({
    show: ONLY, onSite: !!rec, siteHasPlayer: !!(rec && rec.soundcloud),
    // the address the site looks for (scrape-modem.js resolveSoundcloud; old shows have a few exceptions)
    expected: `https://soundcloud.com/modemodemodem/modem-${ONLY < 10 ? '0' + ONLY : ONLY}`,
    soundcloud: (rec && rec.soundcloud) || resolveSoundcloud(ONLY, { hit: false }),
  }));
  process.exit(0);
}

const recent = d.records
  .filter((r) => r.type === 'show' && Number(r.number) && (ONLY == null || Number(r.number) === ONLY))
  .sort((a, b) => Number(b.number) - Number(a.number))
  .slice(0, ONLY == null ? RECENT : 1)
  .filter((r) => (ONLY == null && !r.mp3) || !r.soundcloud);

if (!recent.length) {
  console.log(ONLY == null
    ? `backfill: the ${RECENT} most recent shows all have mp3 + SoundCloud.`
    : `backfill: modem-${ONLY} ${d.records.some((r) => r.type === 'show' && Number(r.number) === ONLY) ? 'already has its SoundCloud player' : 'is not on the site'}.`);
  process.exit(0);
}

let changed = 0;
for (const r of recent) {
  const got = [];
  if (ONLY == null && !r.mp3) {
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
  const still = [ONLY == null && !r.mp3 && 'mp3', !r.soundcloud && 'soundcloud'].filter(Boolean);
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
