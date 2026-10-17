// Bandcamp → SoundCloud link routes for the show builder.
//
// A Bandcamp track on the live site can carry an `scPlay` (a SoundCloud track
// id or URL) so the custom player streams the SoundCloud upload while the
// credit/link stays Bandcamp — see scripts/apply-sc-matches.js. Until now that
// was a separate review page on the main dev server (scripts/gen-review.js →
// /match-review). These routes bring the same workflow into the show builder:
//
//   • per-track, while building a show:   POST /sc/find   (search ONE track)
//     — the pick is stored on the draft item and written to approvals.json at
//     publish time by scripts/apply-draft-sc.js, once the track exists in the
//     archive;
//   • the backlog of every unlinked track: GET /sc/queue, POST /sc/approve,
//     POST /sc/search, POST /sc/run-find — the old review page's job, as a tab.
//
// scripts/approvals.json stays the source of truth (key → SoundCloud id/URL, or
// null = "reviewed, no SoundCloud version"); apply-sc-matches.js, run by every
// publish, still turns it into `scPlay` fields in the archive.
const fs = require('fs');
const path = require('path');

const { createSearcher } = require('../scripts/sc-search');
const { getArchive, writeJsonAtomic } = require('./archive-cache');
const jobs = require('./jobs');

const SCRIPTS = path.join(__dirname, '..', 'scripts');
const CAND_FILE = path.join(SCRIPTS, 'sc-match-candidates.json');
const APPROVALS_FILE = path.join(SCRIPTS, 'approvals.json');

let searcher = null;
const getSearcher = () => searcher || (searcher = createSearcher());

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

// Must mirror scripts/build-track-index.js's keyOf() — the same key
// show-builder/duplicate-check.js builds for "previously played" lookups.
function archiveKey(item) {
  if (item.albumId || item.trackId) return 'bc:' + (item.albumId || '-') + ':' + (item.trackId || '-');
  return item.key || null;
}

const inShow = (t) => (t.shows || []).some((s) => s.type === 'show');

// Order the backlog like the old review page: real decisions first, then the
// pre-approved "auto" tier, then weak guesses, then tracks with nothing at all.
const rankOf = (o) => (o.tier === 'review' ? 0 : o.tier === 'auto' ? 1 : (o.candidates.length ? 2 : 3));

function mount(app) {
  // ---------- /sc/queue — every Bandcamp show track + its candidates ------
  // scripts/sc-match-candidates.json only knows the tracks that existed the
  // last time find-sc-matches.js ran; any newer Bandcamp track in the archive
  // (e.g. a show published since) is added as an empty entry so it can still
  // be searched for and linked.
  app.get('/sc/queue', (req, res) => {
    try {
      const cands = readJson(CAND_FILE, []);
      const known = new Set(cands.map((o) => o.key));
      const entries = cands.slice();
      for (const t of getArchive().tracks || []) {
        if (t.kind !== 'bandcamp' || !inShow(t) || known.has(t.key)) continue;
        entries.push({
          key: t.key, bcTitle: t.title || '', bcArtist: t.artist || '', bcArt: t.artUrl || '',
          bcLink: t.link || '', bcEmbed: t.embedSrc || '', bcDuration: t.duration || null, bcLabel: '',
          shows: (t.shows || []).map((s) => s.number).filter((n) => n != null),
          candidates: [], tier: 'none', suggest: null, fresh: true,
        });
      }
      entries.sort((a, b) => rankOf(a) - rankOf(b));
      res.json({ ok: true, entries, approvals: readJson(APPROVALS_FILE, {}), candidatesAt: fileTime(CAND_FILE) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /sc/find — search SoundCloud for ONE Bandcamp track ----------
  // item: a show-builder item (or a bare { key, artist, title, link, duration }).
  // Also reports any link that already exists for it — in approvals.json, or on
  // the archive track itself if it was played in an earlier show — so the page
  // can adopt that instead of making you pick again.
  app.post('/sc/find', (req, res) => {
    const item = (req.body && req.body.item) || {};
    const key = archiveKey(item);
    if (!key || !key.startsWith('bc:')) return res.status(400).json({ ok: false, error: 'not a Bandcamp track' });
    try {
      const live = { hit: false };
      const bc = { key, artist: item.artist || '', title: item.title || '', link: item.url || item.link || '', duration: item.duration || null };
      const r = getSearcher().findCandidates(bc, live);
      const approvals = readJson(APPROVALS_FILE, {});
      let current; let currentSource = null; let currentTitle = null;
      if (key in approvals) { current = approvals[key]; currentSource = 'approvals'; }
      else {
        const t = (getArchive().tracks || []).find((x) => x.key === key);
        if (t && t.scPlay) { current = t.scPlay; currentSource = 'archive'; currentTitle = t.scPlayTitle || null; }
      }
      res.json({ ok: true, key, live: live.hit, ...r, current, currentSource, currentTitle });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /sc/search — free-text SoundCloud track search ----------------
  app.post('/sc/search', (req, res) => {
    const q = String((req.body && req.body.q) || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'empty search' });
    try {
      const ref = (req.body && req.body.ref) || null;
      res.json({ ok: true, candidates: getSearcher().searchText(q, ref, { hit: false }) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /sc/approve — save decisions to approvals.json ----------------
  // `changes` is { key: soundcloudId | url | null } and `undo` a list of keys to
  // forget — merged into approvals.json rather than replacing it, so a stale
  // tab can never wipe decisions made elsewhere (another tab, the publish
  // pipeline's apply-draft-sc.js, the old review page).
  //
  // Only the decision file is written — NOT the archive. The publish pipeline
  // turns approvals.json into the site's `scPlay` fields (apply-sc-matches.js)
  // every time, so the archive only ever changes during a publish and is pushed
  // straight after; an archive left modified for days would make every Sync's
  // `git pull` fail as soon as the automatic GitHub update commits its own copy.
  //
  // The airtight "auto" matches (exact title + duration, see sc-search.js) are
  // written into approvals.json too, exactly as the old review page did when it
  // saved: sc-match-candidates.json is a local, uncommitted file, so a match that
  // only lived there would vanish again when the other machine publishes.
  app.post('/sc/approve', (req, res) => {
    const changes = (req.body && req.body.changes) || {};
    const undo = (req.body && req.body.undo) || [];
    try {
      const approvals = readJson(APPROVALS_FILE, {});
      for (const k of Object.keys(changes)) {
        const v = changes[k];
        if (v === null || typeof v === 'number' || (typeof v === 'string' && v.trim())) approvals[k] = typeof v === 'string' ? v.trim() : v;
      }
      for (const k of undo) delete approvals[k];
      let autos = 0;
      for (const o of readJson(CAND_FILE, [])) {
        if (o.tier === 'auto' && o.suggest && !(o.key in approvals)) { approvals[o.key] = o.suggest; autos++; }
      }
      writeJsonAtomic(APPROVALS_FILE, approvals);
      res.json({ ok: true, saved: Object.keys(changes).length + undo.length, autos });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /sc/run-find — the batch finder (slow), as a background job --
  app.post('/sc/run-find', (req, res) => {
    jobs.enqueue('sc-find', [[[path.join(SCRIPTS, 'find-sc-matches.js')], 'find-sc-matches.js']]);
    res.json({ ok: true, started: true });
  });

  app.get('/sc/job/:name', (req, res) => {
    const name = req.params.name;
    if (name !== 'sc-find') return res.status(404).json({ ok: false, error: 'unknown job' });
    res.json({ ok: true, ...jobs.status(name) });
  });
}

function fileTime(file) {
  try { return fs.statSync(file).mtime.toISOString(); } catch (e) { return null; }
}

module.exports = { mount, archiveKey };
