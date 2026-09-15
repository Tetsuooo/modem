#!/usr/bin/env node
/*
 * build-label-logos.js — scrapes a profile picture for every label (or, in a
 * few cases, artist) featured in the "best labels of <year>" / "modem
 * community lists" pages, for the small logo shown next to each heading
 * there (see injectLabelLogos() in src/archive.html).
 *
 * Keyed by NAME (hardKeyName()'d), not by a handle scraped off any one
 * record's own heading — the same label is often linked differently (or not
 * at all) from one year's list to the next, and the exact same normalization
 * archive.html's injectLabelLogos() uses to look a name up is duplicated
 * here so the two stay in lockstep. To resolve a name's logo:
 *
 *   1. Scan every OTHER label-list page's bodyHtml (best-labels-of-*,
 *      best-of-2017, community-lists — never radio-show pages) for a
 *      seg-marker heading whose data-seg lines up with a rec.labels[]/
 *      rec.artists[] entry, and pull whatever Bandcamp/SoundCloud profile
 *      links that heading carries. Deliberately NOT show pages: a show's
 *      heading often credits a label next to a guest artist's own link in
 *      the same <p> (e.g. "Genot Centre" next to that episode's one-off
 *      guest), and picking up that guest's link instead of the label's own
 *      produced genuinely wrong logos — every label-list page's own heading
 *      link, by contrast, was consistently the label's own page wherever it
 *      appeared, across every year checked.
 *   2. Fetch that Bandcamp profile's actual "about" bio picture (the
 *      <img class="band-photo"> inside #bio-container) — NOT og:image,
 *      which some Bandcamp pages set to their latest release's cover art
 *      instead of the band photo, and which for a label whose bare domain
 *      redirects straight to their newest release is that release's own
 *      cover, not a picture of the label at all. If the bare domain has no
 *      bio-container (exactly the redirect-to-latest-release case), retry
 *      once at /music, which reliably keeps the bio sidebar. Only when
 *      Bandcamp has nothing at all does a SoundCloud profile's og:image
 *      (genuinely the user's avatar there, unlike Bandcamp's) step in.
 *
 * Output: src/assets/label_logos/<hardkey>.jpg (downloaded images) +
 * src/assets/label-logos.json ({ hardkey: "assets/label_logos/<hardkey>.jpg" }).
 *
 * Cached in scripts/.cache (gitignored) like the other scrapers here, so
 * re-runs only fetch names that are new or previously failed.
 *
 * Usage:
 *   node scripts/build-label-logos.js            # use cache where present
 *   node scripts/build-label-logos.js --fresh    # ignore cache, re-fetch
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ARCHIVE_FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const LOGOS_DIR = path.join(ROOT, 'src', 'assets', 'label_logos');
const LOGOS_JSON = path.join(ROOT, 'src', 'assets', 'label-logos.json');
const CACHE_DIR = path.join(__dirname, '.cache');
const FRESH = process.argv.includes('--fresh');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Must match archive.html's hardKeyName() exactly — this is the shared key
// space both sides look names up in.
function hardKeyName(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[̀-ͯ]/g, '').replace(/[\s._*|~^;:`'"()[\]/\\?<>-]/g, '');
}

function curlCached(key, url) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, 'logo-' + key.replace(/[^\w.-]/g, '_'));
  if (!FRESH && fs.existsSync(cacheFile)) return { body: fs.readFileSync(cacheFile, 'utf8'), live: false };
  const body = execFileSync(
    'curl',
    ['-sS', '-L', '--compressed', '--max-time', '25', '-A', UA, '-H', 'Accept-Language: en;q=0.9', url],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  fs.writeFileSync(cacheFile, body);
  return { body, live: true };
}

// A heading sometimes credits TWO names at once sharing both their links in
// one <p> (e.g. best-labels-of-2019's "Heel, Clam" heading links both
// heel-zone.bandcamp.com and clam-pressure.bandcamp.com; 2020/2021's
// "KRAAK / KRUT" links both kraak.bandcamp.com and krutrecords.bandcamp.com)
// — picking blindly by link ORDER gave both names the same, only-sometimes-
// right handle. When more than one candidate link exists, prefer whichever
// handle textually relates to THIS entry's own name (its ascii-stripped
// lowercase form is a substring of the handle or vice versa); only fall back
// to the first link when nothing name-matches, same as the old behavior.
function pickByName(candidates, nameKey) {
  if (!candidates.length) return null;
  if (nameKey && nameKey.length >= 3) {
    const hit = candidates.find((h) => {
      const hk = h.replace(/[^a-z0-9]/gi, '');
      return hk.includes(nameKey) || nameKey.includes(hk);
    });
    if (hit) return hit;
  }
  return candidates[0];
}
function extractBandcampHandle(hrefs, nameKey) {
  const candidates = [];
  for (const h of hrefs) {
    const m = h.match(/https?:\/\/([^./"]+)\.bandcamp\.com/i);
    if (m && !/^(www|w)$/i.test(m[1])) candidates.push(m[1].toLowerCase());
  }
  return pickByName(candidates, nameKey);
}
const SC_NON_PROFILE = /^(you|search|stream|tracks|discover|upload|pages|charts|people|the-upload-drop|mobile|go)$/i;
function extractSoundcloudHandle(hrefs, nameKey) {
  const candidates = [];
  for (const h of hrefs) {
    const m = h.match(/https?:\/\/(?:www\.)?soundcloud\.com\/([^/?#"]+)/i);
    if (m && !SC_NON_PROFILE.test(m[1])) candidates.push(m[1].toLowerCase());
  }
  return pickByName(candidates, nameKey);
}

// Every "best labels"/"best of <year>"/"community lists" page — the ones
// injectLabelLogos() actually shows a logo on. Detected the same way
// archive.html itself decides a list page uses show-style seg-marker
// headings (structural, not by slug, so a future year's page qualifies
// automatically).
function targetRecords(data) {
  return (data.records || []).filter((r) => r.type === 'list' && /<p data-seg="\d+"[^>]*class="seg-marker"/.test(r.bodyHtml || ''));
}

// name (hardKeyName) -> { bandcamp: handle|null, soundcloud: handle|null },
// built ONLY from the label-list pages themselves (see the file header for
// why show pages are excluded) — a label linked correctly on any ONE of
// these pages covers every other one that names it.
function collectCandidates(records) {
  const byName = new Map();
  const segRe = /<p data-seg="(\d+)"[^>]*class="seg-marker"[^>]*>([\s\S]*?)<\/p>/g;
  records.forEach((rec) => {
    const bySeg = new Map(); // seg -> hrefs[]
    let m;
    segRe.lastIndex = 0;
    while ((m = segRe.exec(rec.bodyHtml || ''))) {
      const hrefs = [...m[2].matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
      bySeg.set(m[1], hrefs);
    }
    if (!bySeg.size) return;
    const entries = [...(rec.labels || []), ...(rec.artists || [])];
    entries.forEach((entry) => {
      if (!entry.name || entry.seg == null) return;
      const hrefs = bySeg.get(String(entry.seg));
      if (!hrefs) return;
      const nameKey = entry.name.toLowerCase().replace(/[^a-z0-9]/gi, '');
      const bandcamp = extractBandcampHandle(hrefs, nameKey);
      const soundcloud = extractSoundcloudHandle(hrefs, nameKey);
      if (!bandcamp && !soundcloud) return;
      const key = hardKeyName(entry.name);
      if (!key) return;
      const cur = byName.get(key) || { bandcamp: null, soundcloud: null };
      if (bandcamp && !cur.bandcamp) cur.bandcamp = bandcamp;
      if (soundcloud && !cur.soundcloud) cur.soundcloud = soundcloud;
      byName.set(key, cur);
    });
  });
  return byName;
}

function targetNames(records) {
  const names = new Map(); // hardKeyName -> display name (first seen, for logging)
  records.forEach((rec) => {
    [...(rec.labels || []), ...(rec.artists || [])].forEach((entry) => {
      if (!entry.name) return;
      const key = hardKeyName(entry.name);
      if (key && !names.has(key)) names.set(key, entry.name);
    });
  });
  return names;
}

// The real "about" bio picture Bandcamp shows in the page sidebar — distinct
// from og:image, which is sometimes the newest release's cover instead.
function bioPhoto(body) {
  const bioIdx = body.indexOf('id="bio-container"');
  if (bioIdx === -1) return null;
  // <img>'s attribute order isn't guaranteed (src before class, or after) —
  // grab the whole tag first, then pull src out of it regardless of order.
  const chunk = body.slice(bioIdx, bioIdx + 3000);
  const imgTag = chunk.match(/<img\b[^>]*class="band-photo"[^>]*>/);
  if (!imgTag) return null;
  const src = imgTag[0].match(/src="([^"]+)"/);
  return src ? src[1] : null;
}
function ogImage(body) {
  const m = body.match(/<meta property="og:image" content="([^"]+)"/i);
  return m ? m[1] : null;
}
function fetchBandcampLogo(handle) {
  const root = curlCached('bc-' + handle + '.html', `https://${handle}.bandcamp.com`);
  let photo = bioPhoto(root.body);
  if (photo) return photo;
  // Bare domain sometimes redirects straight to the newest release instead
  // of the bio/discography page (no #bio-container at all there) — /music
  // reliably keeps the sidebar bio.
  const music = curlCached('bc-' + handle + '-music.html', `https://${handle}.bandcamp.com/music`);
  photo = bioPhoto(music.body);
  return photo || null;
}
function fetchSoundcloudLogo(handle) {
  const { body } = curlCached('sc-' + handle + '.html', `https://soundcloud.com/${handle}`);
  return ogImage(body); // SoundCloud's og:image really is the profile avatar
}
function downloadImage(url, destPath) {
  execFileSync('curl', ['-sS', '-L', '--max-time', '25', '-A', UA, '-o', destPath, url]);
}

// The lookup KEY (hardKeyName) needs full Unicode fidelity to match what
// archive.html computes client-side — but passing non-ASCII straight through
// as a FILENAME hit a real Windows curl/child_process encoding bug (a name
// like "Mizuha 罔象" silently wrote to "mizuha__.jpg" on disk while the JSON
// pointed at "mizuha罔象.jpg", a file that never existed — the image quietly
// 404'd). Strip to ASCII for the on-disk name only, falling back to a short
// deterministic hash on the rare name that strips to nothing at all.
function safeFileSlug(key) {
  const ascii = key.replace(/[^a-z0-9]/gi, '');
  if (ascii) return ascii;
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return 'logo-' + hash.toString(36);
}

(async () => {
  const data = JSON.parse(fs.readFileSync(ARCHIVE_FILE, 'utf8'));
  const targets = targetRecords(data);
  console.log('target records: ' + targets.map((r) => r.slug).join(', '));

  const candidates = collectCandidates(targets); // label-list pages only
  const names = targetNames(targets);
  console.log('names needing a logo: ' + names.size);

  fs.mkdirSync(LOGOS_DIR, { recursive: true });
  const logos = fs.existsSync(LOGOS_JSON) ? JSON.parse(fs.readFileSync(LOGOS_JSON, 'utf8')) : {};

  let fetched = 0, skipped = 0, failed = 0;
  for (const [key, displayName] of names) {
    const slug = safeFileSlug(key);
    const destPath = path.join(LOGOS_DIR, `${slug}.jpg`);
    if (!FRESH && logos[key] && fs.existsSync(path.join(ROOT, 'src', logos[key]))) {
      skipped++;
      continue;
    }
    const cand = candidates.get(key) || {};
    let imgUrl = null, via = null;
    try {
      if (cand.bandcamp) { imgUrl = fetchBandcampLogo(cand.bandcamp); via = 'bandcamp:' + cand.bandcamp; }
      if (!imgUrl && cand.soundcloud) { imgUrl = fetchSoundcloudLogo(cand.soundcloud); via = 'soundcloud:' + cand.soundcloud; }
      if (!imgUrl) {
        console.log('  no logo found: ' + displayName + (cand.bandcamp || cand.soundcloud ? ' (checked ' + [cand.bandcamp && 'bc', cand.soundcloud && 'sc'].filter(Boolean).join('+') + ', no bio picture)' : ' (no bandcamp/soundcloud link on any label-list page)'));
        failed++;
        continue;
      }
      downloadImage(imgUrl, destPath);
      logos[key] = `assets/label_logos/${slug}.jpg`;
      fetched++;
      console.log('  ✓ ' + displayName + ' via ' + via);
      await sleep(300); // polite delay between live network fetches
    } catch (e) {
      console.log('  ✗ ' + displayName + ': ' + (e.message || e));
      failed++;
    }
  }

  fs.writeFileSync(LOGOS_JSON, JSON.stringify(logos, null, 2));
  console.log(`\nfetched ${fetched}, skipped (cached) ${skipped}, failed ${failed} → ${path.relative(ROOT, LOGOS_JSON)}`);
})();
