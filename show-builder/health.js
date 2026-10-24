// "Health" tab — checks that the outside services the show builder and the website lean on
// still behave the way the code expects, and fixes the simple things from the tab itself.
//
// Why: SoundCloud and Bandcamp change their (undocumented) insides without notice. In Oct
// 2026 SoundCloud dropped plain MP3 streams, and every Scan preview fell back to the big
// widget; these checks find that kind of thing on an ordinary day, not on show night.
//
// Each check runs in its own child process (`node show-builder/health.js --check <id>`):
// the scan modules use blocking curl calls, so this keeps the server responsive and lets the
// checks run side by side. Results are kept in data/health.json (git-ignored) so the tab and
// the tab button's badge show the last run; the page re-runs everything once a day by itself.
//
// Fixes (POST /health/fix) are only the simple, safe ones: a new SoundCloud key, updating
// yt-dlp, Sync + the latest version (+ npm install when the packages changed), installing
// the test browser, restarting the builder. Anything else says in words what broke, with the
// technical detail to copy for whoever fixes the code.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const HERE = __dirname;
const REPO_ROOT = path.join(HERE, '..');
const STATE_FILE = path.join(HERE, 'data', 'health.json');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const SITE = 'https://modemodemodem.xyz';
const FEED = 'https://radiostudent.si/glasba/modem/podcast';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';
// Where the website expects SoundCloud's play button inside its 300 x 166 player, for the
// Instagram tap window (src/archive.html .sc-hidden margins, src/index.html placeTapwins()).
const PLAY_BUTTON = { x: 8, y: 11, w: 43, h: 43 };
// The website's own widget parameters (src/archive.html), so the layout is the one it gets.
const WIDGET_QS = '&auto_play=false&buying=false&sharing=false&download=false&show_artwork=false' +
  '&show_comments=false&show_playcount=false&visual=false&hide_related=true';
// A Bandcamp page to fall back on when the wishlist can't give one.
const BC_FALLBACK = 'https://gudserben.bandcamp.com/track/eydn-nanning';

const CHECKS = [
  { id: 'version', name: 'This copy of the builder', what: 'Whether this computer has the latest version, and whether the builder needs a restart to use it.' },
  { id: 'sc-access', name: 'SoundCloud access', what: 'The key the builder uses to talk to SoundCloud — everything SoundCloud in Scan, previews, SoundCloud links and the Year-end list.' },
  { id: 'sc-scan', name: 'SoundCloud scan', what: "Reading modemodemodem's reposts — the SoundCloud half of Scan." },
  { id: 'sc-preview', name: 'SoundCloud previews', what: 'Playing a SoundCloud track in the small player (Scan, Year-end list).' },
  { id: 'sc-search', name: 'SoundCloud search', what: 'Finding tracks on SoundCloud — the SoundCloud links tab and "Find links".' },
  { id: 'bc-scan', name: 'Bandcamp scan', what: 'Reading your Bandcamp wishlist and collection — the Bandcamp half of Scan.' },
  { id: 'bc-release', name: 'Bandcamp releases', what: 'Reading a release page: previews, album tracks, pre-order flags.' },
  { id: 'downloads', name: 'Downloads (yt-dlp)', what: '"Download selected" — yt-dlp fetching tracks from SoundCloud and Bandcamp.' },
  { id: 'ffmpeg', name: 'ffmpeg', what: 'Turns downloads into mp3s and puts the covers in.' },
  { id: 'sc-player', name: "SoundCloud's player (Instagram)", what: "On the website, playing inside Instagram's browser depends on where SoundCloud's play button sits in its player." },
  { id: 'sc-oembed', name: 'SoundCloud show lookups', what: "How the website finds each show's SoundCloud upload (auto-update, publishing)." },
  { id: 'radio', name: 'radioštudent feed', what: "Where the website's Monday/Tuesday auto-update learns about new shows." },
  { id: 'site', name: 'The website', what: "modemodemodem.xyz is up, and its newest show is radioštudent's newest." },
];

// ---------- small helpers --------------------------------------------------------------
function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

// GET with status, response headers and body; `range` asks for the first bytes only.
function fetchUrl(url, { headers = {}, range = null, max = 25 } = {}) {
  const args = ['-sS', '-L', '--compressed', '--max-time', String(max), '-A', UA, '-D', '-'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (range) args.push('-r', range);
  args.push(url);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  // -L prints every hop's headers; the last block is the answer
  const blocks = out.split(/\r?\n\r?\n/);
  let i = 0;
  while (i + 1 < blocks.length && /^HTTP\//.test(blocks[i + 1])) i++;
  const head = blocks[i] || '';
  const status = Number((head.match(/^HTTP\/[\d.]+ (\d+)/) || [])[1]) || 0;
  const header = (name) => (head.match(new RegExp('^' + name + ':\\s*(.*)$', 'im')) || [])[1] || '';
  return { status, header, body: blocks.slice(i + 1).join('\n\n') };
}

function newestShow() {
  const d = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'src', 'assets', 'modem-archive.json'), 'utf8'));
  return (d.records || [])
    .filter((r) => r.type === 'show' && typeof r.number === 'number' && r.soundcloud && r.soundcloud.track)
    .sort((a, b) => b.number - a.number)[0];
}

function feedNewest() {
  const r = fetchUrl(FEED, { max: 40 });
  if (r.status !== 200) throw new Error(`radioštudent feed answered ${r.status}`);
  // only the canonical show link (".../glasba/modem/modem-242"), as scripts/auto-update.js
  const nums = [...r.body.matchAll(/\/modem\/modem-0*(\d{1,4})\b/gi)].map((m) => Number(m[1])).filter((n) => n > 0 && n < 9000);
  return nums.length ? Math.max(...nums) : 0;
}

// The newest wishlist item (its page and track), else the fixed page above.
function bandcampSample() {
  try {
    const bc = require('./scan-bandcamp');
    const { curlPostJson } = require('./lib');
    const data = JSON.parse(curlPostJson('https://bandcamp.com/api/fancollection/1/wishlist_items', { fan_id: bc.getFanId(false), older_than_token: `${Math.floor(Date.now() / 1000)}:9999999999:a::`, count: 1 }));
    const it = data.items && data.items[0];
    if (it) return { url: it.item_url, trackId: it.tralbum_type === 'a' ? it.featured_track : it.tralbum_id, name: `“${it.item_title}”` };
  } catch (e) { /* the fallback page */ }
  return { url: BC_FALLBACK, trackId: null, name: 'a test track' };
}

const verNum = (v) => String(v || '').split('.').map((x) => Number(x) || 0);
function olderVersion(a, b) {
  const x = verNum(a), y = verNum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  }
  return false;
}

const ok = (summary, detail) => ({ status: 'ok', summary, detail: detail || '' });
const warn = (summary, detail, fix, fixLabel) => ({ status: 'warn', summary, detail: detail || '', fix: fix || null, fixLabel: fixLabel || null });
const fail = (summary, detail, fix, fixLabel) => ({ status: 'fail', summary, detail: detail || '', fix: fix || null, fixLabel: fixLabel || null });
const skip = (summary, detail, fix, fixLabel) => ({ status: 'skip', summary, detail: detail || '', fix: fix || null, fixLabel: fixLabel || null });
const errText = (e) => String((e && (e.stderr || e.message)) || e).trim().slice(0, 1500);

// ---------- the checks (run in a child process) ----------------------------------------
const RUN = {
  version(startedHead) {
    const head = git(['rev-parse', 'HEAD']).trim();
    const subject = git(['log', '-1', '--format=%s']).trim();
    let reached = true;
    try { git(['fetch', '-q', 'origin', 'main']); } catch (e) { reached = false; }
    const incoming = git(['log', '--format=%h %s', 'HEAD..origin/main']).trim().split('\n').filter(Boolean);
    const files = incoming.length ? git(['diff', '--name-only', 'HEAD...origin/main']).trim().split('\n') : [];
    // the builder's own code (not its synced data files) or the scripts it runs
    const code = files.filter((f) => /^(show-builder\/(?!data\/)|scripts\/|package(-lock)?\.json$)/.test(f));
    const restart = startedHead && startedHead !== head;
    if (code.length) {
      return warn(`There's a newer version of the builder on GitHub (${incoming.length} change${incoming.length > 1 ? 's' : ''}).`,
        incoming.slice(0, 12).join('\n'), 'update', 'Sync + get the latest version');
    }
    if (restart) {
      return warn('This computer has a newer version than the one running — restart the builder to use it.',
        `running ${startedHead.slice(0, 7)}, on disk ${head.slice(0, 7)} ${subject}`, 'restart', 'Restart the builder');
    }
    if (!reached) return ok("Running the version on this computer (couldn't reach GitHub to compare).", `${head.slice(0, 7)} ${subject}`);
    return ok(incoming.length
      ? `Latest version. GitHub also has ${incoming.length} site update${incoming.length > 1 ? 's' : ''} — Sync brings them.`
      : 'Latest version, and it’s the one running.', `${head.slice(0, 7)} ${subject}`);
  },

  'sc-access'() {
    const sc = require('./scan-soundcloud');
    let cid;
    try {
      cid = sc.getClientId(false);
    } catch (e) {
      return fail("The builder can't get a key from SoundCloud's website any more — SoundCloud changed how its site is built. Needs a code fix (scan-soundcloud.js deriveClientId).", errText(e), 'sc-key', 'Try a new SoundCloud key');
    }
    // apiV2Get gets a new key by itself once if this one was retired (401)
    const { data } = sc.apiV2Get('https://api-v2.soundcloud.com/resolve?url=' + encodeURIComponent('https://soundcloud.com/modemodemodem'), cid);
    if (!data || data.kind !== 'user') return fail("SoundCloud answered, but not with the modemodemodem account — its API changed. Needs a code fix.", JSON.stringify(data).slice(0, 400));
    return ok(`Works (reads the ${data.username} account: ${data.track_count} uploads).`);
  },

  'sc-scan'() {
    const sc = require('./scan-soundcloud');
    const items = sc.scanReposts(new Date(Date.now() - 14 * 864e5));
    return ok(`Works: ${items.length} repost${items.length === 1 ? '' : 's'} in the last 14 days.`);
  },

  'sc-preview'() {
    const sc = require('./scan-soundcloud');
    const show = newestShow();
    const r = sc.resolveStreamUrl(show.soundcloud.track);
    if (!r.url) {
      return fail("SoundCloud gave no stream the small player can use, so previews fall back to SoundCloud's own player. Needs a code fix (scan-soundcloud.js resolveStreamUrl).",
        `tested with ${show.soundcloud.track}`);
    }
    // fetch it the way the page will (from localhost), to see SoundCloud's answer and CORS header
    const res = fetchUrl(r.url, { headers: { Origin: 'http://localhost:8090' }, range: r.hls ? null : '0-1023' });
    if (res.status >= 400 || !res.status) return fail(`SoundCloud found the stream but won't hand it out (HTTP ${res.status}). Needs a code fix.`, r.url.slice(0, 200));
    if (r.hls) {
      if (!/^#EXTM3U/.test(res.body)) return fail("SoundCloud's stream isn't the playlist hls.js expects any more. Needs a code fix.", res.body.slice(0, 300));
      if (/#EXT-X-KEY/.test(res.body)) return fail('SoundCloud now encrypts the stream — the small player can’t play it. Needs a code fix (or a different way to preview).', res.body.slice(0, 300));
      if (!res.header('access-control-allow-origin')) return fail("SoundCloud stopped letting other pages play its stream (no CORS header), so the small player can't. Needs a code fix (a proxy in server.js).", '');
    }
    return ok(`Works (${r.hls ? 'HLS stream, played by hls.js' : 'plain MP3 stream'}), tested with show ${show.number}.`);
  },

  'sc-search'() {
    const { createSearcher } = require('../scripts/sc-search');
    const hits = createSearcher({ fresh: true }).searchText('modem', null, null);
    if (!hits.length) return fail("SoundCloud's search came back empty for \"modem\" — its API changed. Needs a code fix (scripts/sc-search.js).");
    return ok(`Works (${hits.length} results for “modem”).`);
  },

  'bc-scan'() {
    const bc = require('./scan-bandcamp');
    const { curlPostJson } = require('./lib');
    let fanId;
    try {
      fanId = bc.getFanId(true); // re-read off the page, as a new machine would
    } catch (e) {
      return fail("Bandcamp changed its wishlist page — the builder can't find your account on it. Needs a code fix (scan-bandcamp.js getFanId).", errText(e));
    }
    const token = `${Math.floor(Date.now() / 1000)}:9999999999:a::`;
    const counts = [];
    let newest = null;
    for (const endpoint of ['wishlist_items', 'collection_items']) {
      const data = JSON.parse(curlPostJson(`https://bandcamp.com/api/fancollection/1/${endpoint}`, { fan_id: fanId, older_than_token: token, count: 3 }));
      if (data.error) return fail(`Bandcamp refused the ${endpoint === 'wishlist_items' ? 'wishlist' : 'collection'} request — its API changed. Needs a code fix.`, data.error_message || JSON.stringify(data).slice(0, 300));
      if (!Array.isArray(data.items)) return fail("Bandcamp's wishlist/collection answer looks different now. Needs a code fix (scan-bandcamp.js fetchItems).", JSON.stringify(data).slice(0, 300));
      counts.push(data.items.length);
      if (!newest && data.items[0]) newest = data.items[0];
    }
    return ok(`Works${newest ? ` (newest: “${newest.item_title}” by ${newest.band_name})` : ''}.`);
  },

  'bc-release'() {
    const bc = require('./scan-bandcamp');
    const { url, trackId, name } = bandcampSample();
    let r;
    try {
      r = bc.resolveStreamUrl(url, trackId);
    } catch (e) {
      const page = fetchUrl(url);
      if (page.status === 403 || page.status === 429 || /challenge|captcha|cf-chl/i.test(page.body.slice(0, 5000))) {
        return fail(`Bandcamp is blocking the builder's requests (HTTP ${page.status}, bot protection). Scan, previews and downloads from Bandcamp are affected. Needs a code fix — or wait a day, it can be temporary.`, url);
      }
      return fail("Bandcamp changed its release pages — previews, album tracks and pre-order flags need a code fix (scan-bandcamp.js).", `${errText(e)}\n${url}`);
    }
    if (!r.url) return warn(`Release page read, but ${name} has no stream right now (a pre-order or a track that doesn't stream).`, url);
    const res = fetchUrl(r.url, { range: '0-1023' });
    if (res.status >= 400 || !res.status) return fail(`Bandcamp found the stream but won't hand it out (HTTP ${res.status}).`, r.url.slice(0, 200));
    return ok(`Works, tested with ${name}.`);
  },

  downloads() {
    let version, python;
    try {
      [version, python] = execFileSync(PYTHON_CMD, ['-c', "import sys, yt_dlp, requests; print(yt_dlp.version.__version__, '.'.join(map(str, sys.version_info[:3])))"],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().split(/\s+/);
    } catch (e) {
      const t = errText(e);
      if (/No module named/i.test(t)) return fail('yt-dlp (or a part it needs) isn’t installed for Python, so "Download selected" can’t work.', t, 'ytdlp', 'Install yt-dlp');
      return fail(`Python isn't installed here (or isn't on the PATH as "${PYTHON_CMD}") — "Download selected" needs it. Install Python from python.org (tick "Add to PATH"), then restart the builder.`, t);
    }
    let latest = null;
    try { latest = JSON.parse(fetchUrl('https://pypi.org/pypi/yt-dlp/json').body).info.version; } catch (e) { /* offline: no comparison */ }
    const outdated = latest && olderVersion(version, latest);
    const tries = [];
    const sc = newestShow().soundcloud.track;
    for (const [label, url] of [['SoundCloud', sc], ['Bandcamp', bandcampSample().url]]) {
      try {
        const out = execFileSync(PYTHON_CMD, ['-m', 'yt_dlp', '--simulate', '--no-warnings', '--playlist-items', '1', '--print', '%(extractor)s %(ext)s %(duration)s', url],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90000 }).trim();
        tries.push({ label, ok: true, out });
      } catch (e) {
        tries.push({ label, ok: false, out: errText(e) });
      }
    }
    const broken = tries.filter((t) => !t.ok);
    const detail = `yt-dlp ${version}${latest ? ` (newest: ${latest})` : ''}, Python ${python}\n` + tries.map((t) => `${t.label}: ${t.ok ? 'ok — ' : 'FAILED — '}${t.out}`).join('\n');
    // yt-dlp drops old Pythons (3.10 deprecated in 2026 — its own warning); after that it
    // can't be updated on that Python any more, so this has to be noticed before it bites
    const oldPython = olderVersion(python, '3.11');
    if (broken.length) {
      const which = broken.map((t) => t.label).join(' and ');
      return outdated
        ? fail(`yt-dlp can't read ${which} any more. A newer yt-dlp is out, which usually fixes exactly this.`, detail, 'ytdlp', 'Update yt-dlp')
        : fail(`yt-dlp can't read ${which} any more, and it's already the newest version. yt-dlp's makers usually fix this within days — try "Update yt-dlp" again in a day or two.`, detail, 'ytdlp', 'Update yt-dlp');
    }
    const notes = [];
    if (outdated) notes.push(`A newer yt-dlp is out (${latest}) — updating now saves trouble later.`);
    if (oldPython) {
      notes.push(`The builder's Python (${python}) is getting old: yt-dlp is dropping support for it, and after that yt-dlp can't be updated here. Install Python 3.12 or newer from python.org (tick "Add python.exe to PATH"), then press "Update yt-dlp" and restart the builder — or ask Claude to set it up.`);
    }
    if (notes.length) return warn(`Works (yt-dlp ${version}). ${notes.join(' ')}`, detail, 'ytdlp', 'Update yt-dlp');
    return ok(`Works (yt-dlp ${version}, the newest).`, detail);
  },

  ffmpeg() {
    try {
      const first = execFileSync('ffmpeg', ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\n')[0];
      return ok('Installed.', first.trim());
    } catch (e) {
      return fail("ffmpeg isn't installed (or isn't on the PATH) — downloads can't become mp3s and covers can't go in. Install it (in a terminal: winget install Gyan.FFmpeg), then restart the builder.", errText(e));
    }
  },

  async 'sc-player'() {
    let chromium;
    try {
      ({ chromium } = require(path.join(REPO_ROOT, 'node_modules', 'playwright')));
    } catch (e) {
      return skip("Can't check on this computer: the test browser's library (Playwright) isn't installed. Run npm install in the repo folder.", errText(e));
    }
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
    } catch (e) {
      return skip("Can't check on this computer yet: the test browser isn't installed.", errText(e).split('\n')[0], 'browser', 'Install the test browser');
    }
    try {
      const page = await browser.newPage();
      const src = 'https://w.soundcloud.com/player/?url=' + encodeURIComponent(newestShow().soundcloud.api) + WIDGET_QS;
      await page.setContent(`<iframe id="f" width="300" height="166" style="border:0" allow="autoplay" src="${src}"></iframe>`);
      const frame = await (await page.$('#f')).contentFrame();
      try {
        await frame.waitForSelector('.playButton', { state: 'visible', timeout: 25000 });
      } catch (e) {
        return fail("SoundCloud changed its player — its play button isn't where (or what) it was. On the website, playing inside Instagram's browser would break. The site's tap window needs updating (src/index.html placeTapwins, src/archive.html .sc-tapwin / .sc-hidden).", errText(e).split('\n')[0]);
      }
      const b = await frame.$eval('.playButton', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      const off = Math.max(Math.abs(b.x - PLAY_BUTTON.x), Math.abs(b.y - PLAY_BUTTON.y), Math.abs(b.w - PLAY_BUTTON.w), Math.abs(b.h - PLAY_BUTTON.h));
      const where = `play button at ${Math.round(b.x)}, ${Math.round(b.y)} (${Math.round(b.w)} × ${Math.round(b.h)}); the site expects ${PLAY_BUTTON.x}, ${PLAY_BUTTON.y} (${PLAY_BUTTON.w} × ${PLAY_BUTTON.h})`;
      if (off > 3) {
        return fail("SoundCloud moved the play button in its player. On the website, taps inside Instagram's browser would miss it. The site's tap window needs the new position (src/index.html placeTapwins, src/archive.html .sc-hidden).", where);
      }
      return ok("SoundCloud's play button is where the website expects it.", where);
    } finally {
      await browser.close().catch(() => {});
    }
  },

  'sc-oembed'() {
    const show = newestShow();
    const r = fetchUrl('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(show.soundcloud.track));
    let d = null;
    try { d = JSON.parse(r.body); } catch (e) { /* not JSON */ }
    if (!d || !/w\.soundcloud\.com\/player/.test(d.html || '')) {
      return fail("SoundCloud's official show lookup (oEmbed) stopped answering as before — new shows on the site wouldn't get their player. Needs a code fix (scripts/scrape-modem.js resolveSoundcloud).", `HTTP ${r.status}: ${r.body.slice(0, 300)}`);
    }
    return ok(`Works (show ${show.number}: “${d.title}”).`);
  },

  radio() {
    const n = feedNewest();
    if (!n) return fail("radioštudent's podcast feed has no Modem shows in it any more (moved, or the page changed). The website's auto-update won't see new shows; publishing from the builder still works. Needs a look at scripts/auto-update.js.", FEED);
    return ok(`Works: the newest show there is ${n}.`);
  },

  site() {
    const home = fetchUrl(SITE + '/');
    if (home.status !== 200) return fail(`The website doesn't answer properly (HTTP ${home.status}).`, SITE);
    const data = fetchUrl(SITE + '/assets/modem-archive.json', { max: 60 });
    let siteMax = 0;
    try {
      siteMax = Math.max(...JSON.parse(data.body).records.filter((r) => r.type === 'show' && typeof r.number === 'number').map((r) => r.number));
    } catch (e) {
      return fail("The website is up, but its show data didn't load.", `HTTP ${data.status}`);
    }
    let feedMax = 0;
    try { feedMax = feedNewest(); } catch (e) { /* the radio check reports it */ }
    let lastAuto = '';
    try { lastAuto = git(['log', 'origin/main', '--grep=^Auto-update', '-1', '--format=%cr (%h)']).trim(); } catch (e) { /* no info */ }
    if (feedMax > siteMax) {
      return warn(`radioštudent has show ${feedMax}, the website's newest is ${siteMax}. The Monday/Tuesday auto-update (or publishing from the builder) adds it — if this lasts more than a week, the auto-update is stuck.`,
        lastAuto ? `last auto-update with new shows: ${lastAuto}` : '');
    }
    return ok(`Up; newest show ${siteMax}${feedMax ? (feedMax === siteMax ? ', same as radioštudent' : ` (radioštudent: ${feedMax})`) : ''}.`, lastAuto ? `last auto-update with new shows: ${lastAuto}` : '');
  },
};

// ---------- fixes (run in a child process, or by the server) ---------------------------
const FIXES = {
  'sc-key': { label: 'Get a new SoundCloud key', child: true },
  ytdlp: { label: 'Update yt-dlp', cmd: [PYTHON_CMD, ['-m', 'pip', 'install', '-U', 'yt-dlp', 'requests']] },
  browser: { label: 'Install the test browser', cmd: ['npx', ['playwright', 'install', 'chromium']], shell: true },
  update: { label: 'Sync + get the latest version' },
  restart: { label: 'Restart the builder' },
};

function newSoundcloudKey() {
  // the builder's own key (data/.cache) and the SoundCloud-links search's (scripts/.cache)
  const { CACHE_DIR } = require('../scripts/sc-search');
  try { fs.unlinkSync(path.join(CACHE_DIR, 'sc_client_id.txt')); } catch (e) { /* none yet */ }
  const id = require('./scan-soundcloud').getClientId(true);
  const { createSearcher } = require('../scripts/sc-search');
  createSearcher().getClientId();
  return 'new key ' + id.slice(0, 6) + '…';
}

// ---------- the server side ------------------------------------------------------------
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { results: {} }; }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// Runs a command, collecting its output; never rejects.
function runCmd(cmd, args, { shell = false, timeout = 600000, extraArgs = [] } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args.concat(extraArgs), { cwd: REPO_ROOT, shell, windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out: errText(e) });
    }
    const timer = setTimeout(() => { out += '\n(timed out)'; child.kill(); }, timeout);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { out += '\n' + errText(e); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: out.trim() }); });
  });
}

function mount(app) {
  const startedAt = new Date().toISOString();
  let startedHead = '';
  try { startedHead = git(['rev-parse', 'HEAD']).trim(); } catch (e) { /* not a git checkout */ }

  app.get('/health/state', (req, res) => {
    const s = readState();
    res.json({ ok: true, checks: CHECKS, results: s.results || {}, lastRunAt: s.lastRunAt || null, startedAt, canRestart: process.platform === 'win32' });
  });

  app.get('/health/ping', (req, res) => res.json({ ok: true, startedAt }));

  app.post('/health/check', async (req, res) => {
    const id = req.body && req.body.id;
    if (!RUN[id]) return res.status(400).json({ ok: false, error: 'no such check' });
    const t0 = Date.now();
    const r = await runCmd(process.execPath, [path.join(HERE, 'health.js'), '--check', id, startedHead], { timeout: 240000 });
    let result;
    try {
      result = JSON.parse(r.out.split('\n').filter((l) => l.startsWith('{')).pop());
    } catch (e) {
      result = fail('The check itself crashed — copy the details.', r.out.slice(-1500));
    }
    result.at = new Date().toISOString();
    result.ms = Date.now() - t0;
    const s = readState();
    s.results = s.results || {};
    s.results[id] = result;
    // a full run (`run` = when it began) counts once every check has answered since then —
    // one cut short by a restart or a closed page runs again next time
    const run = req.body.run;
    if (run && CHECKS.every((c) => s.results[c.id] && s.results[c.id].at >= run)) s.lastRunAt = run;
    writeState(s);
    res.json({ ok: true, result });
  });

  app.post('/health/fix', async (req, res) => {
    const id = req.body && req.body.id;
    const fix = FIXES[id];
    if (!fix) return res.status(400).json({ ok: false, error: 'no such fix' });
    if (id === 'restart') return res.json(restart());
    if (id === 'update') {
      const before = startedHead || git(['rev-parse', 'HEAD']).trim();
      const result = require('./sync').runSync();
      if (!result.ok) return res.json({ ok: false, log: result.error || result.message || 'Sync stopped' });
      const after = git(['rev-parse', 'HEAD']).trim();
      let log = before === after ? 'Already had the latest version.' : 'Got the latest version:\n' + git(['log', '--format=%h %s', `${before}..${after}`]).trim();
      const changed = before === after ? [] : git(['diff', '--name-only', before, after]).trim().split('\n');
      if (changed.some((f) => /^package(-lock)?\.json$/.test(f))) {
        const npm = await runCmd('npm', ['install'], { shell: true });
        log += `\n\nnpm install (the packages changed): ${npm.code === 0 ? 'done' : 'FAILED'}\n${npm.out.slice(-800)}`;
      }
      return res.json({ ok: true, log, restartNeeded: after !== startedHead });
    }
    if (fix.child) {
      const r = await runCmd(process.execPath, [path.join(HERE, 'health.js'), '--fix', id], { timeout: 120000 });
      return res.json({ ok: r.code === 0, log: r.out });
    }
    const [cmd, args] = fix.cmd;
    const r = await runCmd(cmd, args, { shell: !!fix.shell });
    res.json({ ok: r.code === 0, log: r.out.slice(-3000) });
  });

  // Restart = run start.bat again (it closes this server first — see start.bat), minimised
  // and without opening another browser tab; the page waits for /health/ping to change.
  function restart() {
    if (process.platform !== 'win32') return { ok: false, log: 'Restart it by hand on this computer (stop the server, start it again).' };
    const bat = path.join(HERE, 'start.bat');
    const child = spawn('cmd.exe', ['/d', '/s', '/c', `start "modem show builder restart" /min cmd /c ""${bat}" --restart"`],
      { cwd: REPO_ROOT, detached: true, stdio: 'ignore', windowsVerbatimArguments: true });
    child.unref();
    return { ok: true, log: 'Restarting…' };
  }
  app.post('/health/restart', (req, res) => res.json(restart()));
}

// ---------- child-process entry --------------------------------------------------------
if (require.main === module) {
  const [mode, id, arg] = process.argv.slice(2);
  (async () => {
    if (mode === '--check') {
      let result;
      try {
        result = await RUN[id](arg);
      } catch (e) {
        result = fail('This check hit an error — copy the details.', errText(e));
      }
      process.stdout.write('\n' + JSON.stringify(result) + '\n');
    } else if (mode === '--fix' && id === 'sc-key') {
      process.stdout.write(newSoundcloudKey() + '\n');
    }
  })().catch((e) => { process.stderr.write(errText(e)); process.exit(1); });
}

module.exports = { mount, CHECKS };
