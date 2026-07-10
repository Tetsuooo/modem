/*
 * auto-update.js — detect newly-published Modem shows from the radiostudent
 * podcast feed and, if any, scrape them and run the full pipeline. Safe to run
 * anytime: the scraper is merge-by-default (never drops existing shows) and
 * build-track-index is incremental (only new embeds hit the network). Exits 0
 * with no changes when the archive is already up to date. Run by the GitHub
 * Action on a schedule; also runnable locally: `node scripts/auto-update.js`.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const FEED = 'https://radiostudent.si/glasba/modem/podcast';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function archiveMax() {
  const d = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const nums = (d.records || [])
    .filter((r) => r.type === 'show' && typeof r.number === 'number')
    .map((r) => r.number);
  return nums.length ? Math.max(...nums) : 0;
}

function feedMax() {
  const xml = execFileSync(
    'curl',
    ['-sSL', '--max-time', '40', '-A', UA, FEED],
    { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 }
  );
  // Match ONLY the canonical show link (".../glasba/modem/modem-242") so stray
  // numbers in the feed (years, dates, durations) can't be mistaken for a show
  // number. Handles zero-padded early slugs (modem-01-0 → 1, modem-100-… → 100).
  const nums = [...xml.matchAll(/\/modem\/modem-0*(\d{1,4})\b/gi)]
    .map((m) => Number(m[1]))
    .filter((n) => n > 0 && n < 9000);
  return nums.length ? Math.max(...nums) : 0;
}

const run = (args) => execFileSync('node', args, { stdio: 'inherit', cwd: ROOT });

const have = archiveMax();
let latest = 0;
try {
  latest = feedMax();
} catch (e) {
  console.error('podcast feed fetch failed:', e.message, '— leaving archive unchanged.');
  process.exit(0);
}
console.log('archive latest show:', have, '| feed latest show:', latest);

if (!latest || latest <= have) {
  console.log('Up to date — no new shows to scrape.');
  process.exit(0);
}

const range = (have + 1) + '-' + latest;
console.log('New show(s) detected → scraping', range);
run(['scripts/scrape-modem.js', '--shows', range]);   // merge-by-default: adds only the new shows
run(['scripts/build-track-index.js']);                // incremental: only new embeds are fetched
run(['scripts/apply-sc-matches.js']);                 // re-apply committed SoundCloud matches
run(['scripts/apply-overrides.js']);                  // re-apply committed tag merges/edits
console.log('Auto-update complete: shows', range, 'added.');
