#!/usr/bin/env node
/*
 * add-show-from-draft.js — add (or replace) one show's record in
 * src/assets/modem-archive.json straight from the show-builder draft that built
 * it, instead of scraping the radioštudent page it was pasted into.
 *
 * The show builder already produces everything the site needs: the tracklist
 * HTML (the very HTML pasted into radioštudent), every artist/label credit, the
 * cover. The scraper used to read it all back off radioštudent — which meant
 * waiting for the page to go live, losing tags whenever radioštudent's own tag
 * fields were empty, and picking up any later hand-edit there. Now the draft is
 * the source of truth; radioštudent is just where the show is also published.
 *
 * The record is produced by the SAME parser the scraper uses (parsePage, run on a
 * synthetic page holding the generated HTML — exactly what the Preview tab does),
 * so it has the identical shape: bodyHtml with segment markers, segments, embeds,
 * searchText. What the draft doesn't hold is filled like this:
 *   date      --date "12. 10. 2026", else computed from the two-week schedule
 *   cover     the PNG exported from the Covers tab (show-builder/downloads/
 *             _show_covers/modem-N.png, or --cover <png>) → converted to the site's
 *             local WebP mirror; else the radioštudent page's og:image if it's live
 *   mp3       only exists after the broadcast — patched in later by
 *             backfill-show-audio.js, as for every show
 *   soundcloud the full-show upload, looked up by show number (not on radioštudent)
 *
 * If the draft has a mix (the Mix tab), each track's start in it goes into
 * src/assets/show-timestamps.json for the live tracklist (scripts/tracklists/).
 *
 * The record is marked `origin: "show-builder"`, and a copy of it exactly as built
 * (before tag merges / edits are applied on top) is kept in
 * src/assets/builder-shows.json. scrape-modem.js uses that copy when it re-derives
 * the archive (--reparse) and never re-scrapes such a show, so these shows are
 * never rebuilt from a radioštudent page. Shows scraped the old way are untouched.
 *
 * Usage (run by show-builder's /publish-run; needs the draft for this show):
 *   node scripts/add-show-from-draft.js --show 250 [--date "26. 10. 2026"]
 *                                       [--draft <path>] [--cover <png>]
 *                                       [--replace-existing]
 * An existing record that was scraped from radioštudent is only replaced with
 * --replace-existing; one already built here is simply rebuilt.
 *
 * Next steps in the pipeline (unchanged): apply-draft-sc → build-track-index →
 * apply-sc-matches → apply-overrides → webpack.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');

const { parsePage, resolveSoundcloud, stripTags, firstMatch } = require('./scrape-modem');
const { generateShowHtml } = require('../show-builder/generate-html');
const { buildRecordTags } = require('../show-builder/build-record-tags');
const { timestampsFromDraft, writeShowTimestamps } = require('./tracklists/draft-timestamps');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const BUILDER_FILE = path.join(ROOT, 'src', 'assets', 'builder-shows.json');
const COVERS_DIR = path.join(ROOT, 'src', 'assets', 'modem_covers');
const CURRENT_DRAFT = path.join(ROOT, 'show-builder', 'data', 'current-draft.json');
const SHARED_DRAFT = path.join(ROOT, 'show-builder', 'data', 'shared-draft.json');
const COVER_EXPORT_DIR = path.join(ROOT, 'show-builder', 'downloads', '_show_covers');
const TIMESTAMPS_FILE = path.join(ROOT, 'src', 'assets', 'show-timestamps.json');
const BASE = 'https://radiostudent.si';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const argv = process.argv.slice(2);
const argVal = (flag) => { const i = argv.indexOf(flag); return i !== -1 && argv[i + 1] ? argv[i + 1] : null; };
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
const fail = (msg, code = 1) => { console.error('add-show-from-draft: ' + msg); process.exit(code); };
const pad = (n) => (n < 10 ? `0${n}` : `${n}`); // same as scrape-modem.js — cover filenames must match

// The show airs every second Monday; 249 aired 2026-10-12 (the update workflow's
// cadence gate is anchored the same way). Only a default — the UI lets you edit it.
function scheduledDate(number) {
  const d = new Date(Date.UTC(2026, 9, 12) + (number - 249) * 14 * 86400000);
  return `${d.getUTCDate()}. ${d.getUTCMonth() + 1}. ${d.getUTCFullYear()}`; // "12. 10. 2026" — the site's own format
}

(async () => {
  const show = argVal('--show');
  const number = Number(show);
  if (!show || !Number.isInteger(number) || number <= 0) fail('usage: add-show-from-draft.js --show <N> [--date "D. M. YYYY"] [--draft <path>] [--cover <png>] [--replace-existing]');
  const slug = `modem-${number}`;

  // ---- the draft ----
  const explicitDraft = argVal('--draft');
  const current = readJson(CURRENT_DRAFT);
  const shared = readJson(SHARED_DRAFT);
  let draft = null, source = null;
  if (explicitDraft) { draft = readJson(explicitDraft); source = explicitDraft; }
  else if (current && String(current.showNumber) === String(show)) { draft = current; source = path.relative(ROOT, CURRENT_DRAFT); }
  else if (shared && String(shared.showNumber) === String(show)) { draft = shared; source = path.relative(ROOT, SHARED_DRAFT); }
  if (!draft || !Array.isArray(draft.selected) || !draft.selected.length) {
    fail(`no draft with tracks for modem-${number} (current-draft.json: ${current ? 'show ' + current.showNumber : 'missing'}, ` +
      `shared-draft.json: ${shared ? 'show ' + shared.showNumber : 'missing'}). Check the Show # in the Publish tab matches the draft.`);
  }

  const archive = readJson(ARCHIVE_FILE);
  if (!archive) fail('could not read ' + ARCHIVE_FILE);
  const existing = (archive.records || []).find((r) => r.slug === slug);
  if (existing && existing.origin !== 'show-builder' && !argv.includes('--replace-existing')) {
    fail(`${slug} is already on the site (scraped from radioštudent). Re-run with --replace-existing to replace it with the version built here.`, 2);
  }

  // ---- body: regenerate from the draft so the site always matches the draft as it is NOW —
  // unless the HTML was edited by hand in the Publish tab (draft.htmlEdited, 2026-10-24):
  // then the site gets exactly that, the same as what was pasted into radioštudent ----
  const generated = generateShowHtml(draft.selected);
  const handEdited = !!(draft.htmlEdited && draft.generatedHtml);
  const html = handEdited ? draft.generatedHtml : generated;
  const squash = (s) => String(s || '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();
  if (handEdited) {
    console.log('using the tracklist HTML you edited by hand in the Publish tab');
  } else if (draft.generatedHtml && squash(draft.generatedHtml) !== squash(generated)) {
    console.log('NOTE: the draft has changed since the HTML you last generated/copied for radioštudent — ' +
      'the site gets the CURRENT draft. Generate HTML again and re-paste it there so radioštudent matches.');
  }
  const pageOf = (body) => `<!doctype html><html><head><meta property="og:title" content="modem ///${number}"></head><body>` +
    `<div class="field field--name-body field__item">\n${body}\n</div></body></html>`;
  const page = pageOf(html);
  const sc = resolveSoundcloud(number, { hit: false });
  const rec = parsePage(slug, page, 'show', sc);
  if (handEdited) {
    // the tags below are made per heading of "Your show"; say so if the edited HTML has a
    // different number of headings (they'd land on the wrong ones — fix in Edit site)
    const expected = parsePage(slug, pageOf(generated), 'show', sc).segments || [];
    if ((rec.segments || []).length !== expected.length) {
      console.log(`NOTE: your edited HTML has ${(rec.segments || []).length} headings, "Your show" makes ${expected.length} — ` +
        'the artist/label tags are made per heading of "Your show", so some may sit on the wrong heading. Check the show in Edit site after publishing.');
    }
  }

  // ---- credits straight from the draft (same as apply-draft-tags.js did after a scrape) ----
  const { artists, labels } = buildRecordTags(draft.selected);
  rec.artists = artists;
  rec.labels = labels;

  // ---- date ----
  const dateArg = argVal('--date');
  rec.date = dateArg ? dateArg.trim() : (existing && existing.date) || scheduledDate(number);
  console.log(`air date: ${rec.date}${dateArg ? '' : ' (from the two-week schedule — pass --date to change)'}`);

  rec.searchText = [
    rec.title,
    rec.date,
    artists.map((a) => a.name).join(' '),
    labels.map((l) => l.name).join(' '),
    stripTags(rec.bodyHtml || ''),
  ].filter(Boolean).join(' \n ');

  // ---- cover ----
  fs.mkdirSync(COVERS_DIR, { recursive: true });
  const coverFile = `modem${pad(number)}.webp`;
  const coverDest = path.join(COVERS_DIR, coverFile);
  const coverSrc = argVal('--cover') || path.join(COVER_EXPORT_DIR, `modem-${number}.png`);
  if (fs.existsSync(coverSrc)) {
    await sharp(coverSrc).webp({ quality: 82 }).toFile(coverDest);
    rec.cover = `/assets/modem_covers/${coverFile}`;
    console.log(`cover: ${path.relative(ROOT, coverSrc)} → ${path.relative(ROOT, coverDest)} (${(fs.statSync(coverDest).size / 1024).toFixed(0)}KB)`);
  } else {
    // No export yet — if the show is already on radioštudent with its cover, use that.
    let remote = null;
    try {
      const live = execFileSync('curl', ['-sSL', '--max-time', '30', '-A', UA, `${BASE}/glasba/modem/${slug}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      const og = firstMatch(/<meta property="og:image" content="([^"]*)"/, live);
      if (og && !/<title>\s*Stran ni bila najdena/i.test(live)) remote = og.startsWith('http') ? og : BASE + og;
    } catch (e) { /* not live / offline */ }
    if (remote) {
      try {
        const tmp = coverDest + '.download';
        execFileSync('curl', ['-sSL', '--max-time', '60', '-A', UA, '-o', tmp, remote]);
        await sharp(tmp).webp({ quality: 82 }).toFile(coverDest);
        fs.unlinkSync(tmp);
        rec.cover = remote;
        console.log(`cover: none exported from the Covers tab — used the one on radioštudent (${remote})`);
      } catch (e) { console.warn('  ! could not fetch the radioštudent cover: ' + e.message); }
    }
    if (!rec.cover && existing && existing.cover) { rec.cover = existing.cover; console.log('cover: kept the existing record\'s cover'); }
    if (!rec.cover) console.warn('  ! NO COVER — export one from the Covers tab (Export PNG) and publish again to add it.');
  }

  // Things only learned after publishing (backfill-show-audio.js) survive a re-publish.
  if (existing) for (const k of ['mp3', 'soundcloud']) if (!rec[k] && existing[k]) rec[k] = existing[k];

  rec.origin = 'show-builder';

  // ---- write the as-built copy, then the archive ----
  const builder = readJson(BUILDER_FILE) || {};
  builder[slug] = rec;
  fs.writeFileSync(BUILDER_FILE, JSON.stringify(builder, null, 2));

  // Same ordering/counts as scrape-modem.js's merge — shows first, newest first.
  const records = (archive.records || []).filter((r) => r.slug !== slug).concat(rec);
  records.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'show' ? -1 : 1;
    return (b.number || 0) - (a.number || 0) || a.slug.localeCompare(b.slug);
  });
  archive.records = records;
  archive.generatedAt = new Date().toISOString();
  archive.counts = {
    ...archive.counts,
    total: records.length,
    shows: records.filter((r) => r.type === 'show').length,
    lists: records.filter((r) => r.type === 'list').length,
    withSoundcloud: records.filter((r) => r.soundcloud).length,
    lastScraped: [slug],
  };
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archive, null, 2));

  // ---- live tracklist: each track's start straight from the Mix tab ----
  // (no mix in this draft → leave the show alone; its timestamps come from audio
  // matching later, scripts/tracklists/build_tracklists.py)
  const stamps = timestampsFromDraft(draft);
  if (stamps) {
    writeShowTimestamps(TIMESTAMPS_FILE, slug, stamps);
    console.log(`live tracklist: ${stamps.length} tracks timed from the Mix tab → src/assets/show-timestamps.json`);
  } else {
    console.log('live tracklist: this draft has no mix (Mix tab), so no timestamps yet — they can be matched from the audio later');
  }

  console.log(
    `add-show-from-draft: ${slug} ← ${source} — ${rec.embeds.length} embeds, ${rec.segments.length} segments, ` +
      `artists:${artists.length} labels:${labels.length}${rec.soundcloud ? ', full-show SoundCloud ✓' : ', no full-show SoundCloud yet'}` +
      `${existing ? ' (replaced an existing record)' : ''}`
  );
})().catch((e) => fail(String(e && e.stack || e)));
