// "Year-end list" tab, server half — building the annual "50 best releases" list.
//
// The releases come from year-end-gather.js (a background job: every LP / EP /
// compilation played in that year's shows). The tab (public/yearend.js) is where you
// listen, put releases in or out, and rank the ones in: the first 50 make the list.
//
// Everything for a year lives in data/year-end.json → [year]:
//   candidates  the gathered releases (written by the gather job only)
//   decisions   { key: 'in' | 'out' }   (written by the tab)
//   order       [key, …] — the ranked list, best first (written by the tab)
//   edits       { key: { artist, title, label } } — names fixed by hand for the list
//   gatheredAt, shows, savedAt (ms — Sync keeps the newer copy of each year)
// Sync carries the file between machines (sync.js).
//
// The output is the HTML for radioštudent in the same shape as the published lists
// (e.g. best-releases-of-2025): a heading line, then per release, alphabetical by
// artist, "Artist - Title (Label)" with links, followed by its player.
const fs = require('fs');
const path = require('path');
const jobs = require('./jobs');
const { curlGet, escapeHtml } = require('./lib');
const scanSoundcloud = require('./scan-soundcloud');
const releases = require('./year-end-releases');

const FILE = path.join(__dirname, 'data', 'year-end.json');
const LIST_SIZE = 50;
const HEADING = '★*ﾟ50 best releases in alphabetical order *★';

function readAll() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; } }
function writeAll(all) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 1));
  fs.renameSync(tmp, FILE);
}
const emptyYear = () => ({ candidates: [], decisions: {}, order: [], edits: {}, gatheredAt: null, shows: [], savedAt: 0 });

// a release as it goes on the list: names fixed by hand win; a link only stays with
// the name it belongs to
function withEdits(c, e) {
  if (!e) return c;
  const out = { ...c };
  for (const f of ['artist', 'title', 'label']) if (typeof e[f] === 'string' && e[f].trim() !== '') out[f] = e[f].trim();
  if (e.label === '') out.label = null; // cleared on purpose: self-released
  if (out.artist !== c.artist) out.artistUrl = null;
  if (out.label !== c.label) out.labelUrl = null;
  return out;
}

// The years there are shows for (from the site's archive), newest first.
function showYears() {
  try {
    const { getArchive } = require('./archive-cache');
    const ys = new Set();
    for (const r of getArchive().records || []) {
      const y = Number((String(r.date || '').match(/(\d{4})\s*$/) || [])[1]);
      if (r.type === 'show' && y) ys.add(y);
    }
    return [...ys].sort((a, b) => b - a);
  } catch (e) { return [new Date().getFullYear()]; }
}

// ---------- the list's HTML --------------------------------------------------------------
const link = (url, text) => (url ? `<a href="${escapeHtml(url)}" data-entity-type="external">${escapeHtml(text)}</a>` : escapeHtml(text));
// sorted the way a reader expects: case and accents ignored, a leading "The " too
const sortName = (s) => String(s || '').replace(/^the\s+/i, '').trim();

function bandcampEmbed(c) {
  const parts = ['https://bandcamp.com/EmbeddedPlayer/'];
  if (c.albumId) parts.push(`album=${c.albumId}/`);
  parts.push('size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/');
  if (!c.albumId && c.trackId) parts.push(`track=${c.trackId}/`);
  parts.push('transparent=true/');
  return `<iframe src="${parts.join('')}"><a href="${escapeHtml(c.url)}">${escapeHtml(`${c.title} by ${c.artist}`)}</a></iframe>`;
}
function soundcloudEmbed(c) {
  try {
    const j = JSON.parse(curlGet('https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(c.url)));
    if (j && j.html) return j.html;
  } catch (e) { /* fall back to a plain link, like the shows do */ }
  return `<a href="${escapeHtml(c.url)}">${escapeHtml(c.url)}</a>`;
}

function listHtml(entries) {
  const sorted = [...entries].sort((a, b) =>
    sortName(a.artist).localeCompare(sortName(b.artist), 'en', { sensitivity: 'base' }) ||
    String(a.title || '').localeCompare(String(b.title || ''), 'en', { sensitivity: 'base' }));
  const out = [`<p><strong>${escapeHtml(HEADING)}</strong></p>`];
  const plain = [];
  for (const c of sorted) {
    const label = c.label ? link(c.labelUrl, c.label) : 'self-released';
    out.push(`<p>${link(c.artistUrl, c.artist)} - ${escapeHtml(c.title)} (${label})</p>`);
    // Bandcamp's player where the release has one (the lists have always used it)
    const bc = c.source === 'bandcamp' ? c : null;
    out.push(`<p>${bc ? bandcampEmbed(bc) : soundcloudEmbed(c)}</p>`);
    plain.push(`${c.artist} - ${c.title} (${c.label || 'self-released'})`);
  }
  return { html: out.join('\n'), text: plain.join('\n'), count: sorted.length };
}

function mount(app) {
  app.get('/ye/years', (req, res) => {
    const all = readAll();
    res.json({ ok: true, years: showYears(), gathered: Object.keys(all).map(Number).filter((y) => (all[y].candidates || []).length) });
  });

  app.get('/ye/state', (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    res.json({ ok: true, year, listSize: LIST_SIZE, ...emptyYear(), ...(readAll()[year] || {}) });
  });

  // The tab's picks + order. Only these two fields — the candidates are the gather
  // job's (read again here, so a gather that finished meanwhile isn't undone).
  app.post('/ye/save', (req, res) => {
    const { year, decisions, order, edits } = req.body || {};
    if (!Number(year)) return res.status(400).json({ ok: false, error: 'no year' });
    const all = readAll();
    const y = { ...emptyYear(), ...(all[year] || {}) };
    if (decisions && typeof decisions === 'object') y.decisions = decisions;
    if (Array.isArray(order)) y.order = order;
    if (edits && typeof edits === 'object') y.edits = edits;
    y.savedAt = Date.now();
    all[year] = y;
    writeAll(all);
    res.json({ ok: true, savedAt: y.savedAt });
  });

  app.post('/ye/gather', (req, res) => {
    const year = Number((req.body || {}).year) || new Date().getFullYear();
    const args = ['show-builder/year-end-gather.js', '--year', String(year)];
    if ((req.body || {}).fresh) args.push('--fresh');
    const job = jobs.enqueue('year-end-gather', [[args, `gathering the releases from ${year}'s shows`]]);
    res.json({ ok: true, state: job.state });
  });
  app.get('/ye/gather-status', (req, res) => res.json(jobs.status('year-end-gather')));

  // A SoundCloud set's full track list (the gather only has the first few) — looked
  // up the first time it's played, and kept.
  app.post('/ye/tracks', (req, res) => {
    const { year, key } = req.body || {};
    const all = readAll();
    const c = ((all[year] || {}).candidates || []).find((x) => x.key === key);
    if (!c) return res.status(404).json({ ok: false, error: 'no such release' });
    const complete = (c.tracks || []).length && c.tracks.every((t) => t.url && t.title);
    if (c.kind !== 'set' || complete) return res.json({ ok: true, tracks: c.tracks || [] });
    try {
      const tracks = scanSoundcloud.resolveTracks({ url: c.url }).map((t) => ({
        id: t.id, title: t.title, artist: t.artist || '', url: t.url, duration: t.duration, playable: true,
      }));
      // write into the file as it is now (picks may have been saved meanwhile)
      const fresh = readAll();
      const fc = ((fresh[year] || {}).candidates || []).find((x) => x.key === key);
      if (fc) { fc.tracks = tracks; if (!fc.trackCount) fc.trackCount = tracks.length; writeAll(fresh); }
      res.json({ ok: true, tracks });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // A release added by hand — a Bandcamp / SoundCloud link (one not played in any show:
  // last year 3 of the 50). Becomes a candidate like the gathered ones; a re-gather keeps it.
  app.post('/ye/add', (req, res) => {
    const { year, url } = req.body || {};
    if (!Number(year)) return res.status(400).json({ ok: false, error: 'no year' });
    let c;
    try { c = releases.releaseFromUrl(url); } catch (e) { return res.json({ ok: false, error: String(e.message || e) }); }
    if (!c) return res.json({ ok: false, error: "couldn't read a release there" });
    const all = readAll();
    const y = { ...emptyYear(), ...(all[year] || {}) };
    const have = (y.candidates || []).find((x) => x.key === c.key);
    if (have) return res.json({ ok: true, candidate: have, existed: true });
    c.shows = []; c.playedTracks = 0; c.addedByHand = true;
    c.year = c.releaseDate ? Number(c.releaseDate.slice(0, 4)) : null;
    y.candidates = [...(y.candidates || []), c];
    y.savedAt = Date.now();
    all[year] = y;
    writeAll(all);
    res.json({ ok: true, candidate: c });
  });

  // The HTML for radioštudent: the first 50 of the ranked list, alphabetical.
  app.post('/ye/html', (req, res) => {
    const year = Number((req.body || {}).year);
    const y = readAll()[year];
    if (!y) return res.status(404).json({ ok: false, error: 'nothing saved for ' + year });
    const byKey = new Map((y.candidates || []).map((c) => [c.key, c]));
    const top = (y.order || []).filter((k) => y.decisions[k] === 'in' && byKey.has(k)).slice(0, LIST_SIZE)
      .map((k) => withEdits(byKey.get(k), (y.edits || {})[k]));
    if (!top.length) return res.json({ ok: false, error: 'the list is empty' });
    try {
      res.json({ ok: true, ...listHtml(top), short: Math.max(0, LIST_SIZE - top.length) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
}

module.exports = { mount, listHtml, LIST_SIZE };
