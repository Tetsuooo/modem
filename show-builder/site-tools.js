// "Edit site" tab, server half — read one show (or year-end list) the way the
// site shows it: every heading with the artist/label chips it gets, the tracks
// under it, and the tags that aren't tied to any heading. The front end
// (public/tags.js, "Edit a show") edits those chips into overrides.json's
// segEdits (per heading) and tagEdits (per track) — the same two things the
// pencils on the site's own show pages write when the local website preview
// runs (src/archive.html) — and saving goes through tag-tools.js's /tags/save.
//
// Also serves the built site (docs/) on its own port, so a "Publish site edits"
// run can be looked at in the browser before it's pushed.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const express = require('express');
const { getArchive } = require('./archive-cache');
const { playersBySeg, decode } = require('../scripts/track-order');

const DOCS_DIR = path.join(__dirname, '..', 'docs');
const LIVE_SITE = 'https://modemodemodem.xyz';

// Same key the site uses to tell "the same name styled differently" apart
// (src/archive.html injectSegTags → hardKey).
const hardKey = (s) => (s == null ? '' : String(s)).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[\s._*|~^;:`'"()[\]-]/g, '');
const PLACEHOLDER_ARTIST = /^(v\.?\s?a\.?|various\s+artists?)$/i;

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)));
}
const plainText = (html) => decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\/{2,}/g, ' ').replace(/\s+/g, ' ').trim();

// The headings of one record, in page order, with the chips the site gives
// each one. Mirrors src/archive.html's injectSegTags() — the parts that decide
// a heading's chips: the record's own tags for that heading; for a heading with
// no artist of its own (a label / compilation heading) or several embeds packed
// into one paragraph, every track's own artist; every track's labels; an
// edited heading shows exactly its edit; near-duplicate artists collapse; a
// label that just restates the artist is dropped; an empty heading straight
// before another one hands its chips on to that one. (Not mirrored: the
// promotion of plain name lines into headings on a few very old shows.)
function headingsFor(rec, tracks) {
  const body = rec.bodyHtml || '';
  const markers = [];
  const re = /<p data-seg="(\d+)" class="seg-marker">([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(body))) markers.push({ seg: Number(m[1]), inner: m[2], start: m.index, end: re.lastIndex });
  // each heading's players (track embeds), in page order — for moving tracks (track-order.js)
  const players = playersBySeg(body);

  const arts = {}, labs = {};
  const add = (map, seg, n) => { if (seg != null && n) (map[seg] = map[seg] || []).includes(n) || map[seg].push(n); };
  (rec.artists || []).forEach((a) => add(arts, a.seg, a.name));
  (rec.labels || []).forEach((l) => add(labs, l.seg, l.name));
  const artistHeadingSegs = new Set((rec.artists || []).filter((a) => a.seg != null && a.name).map((a) => a.seg));
  const editedSegs = new Set((rec.segEditedSegs || []).map(Number));

  const packed = new Set();
  const between = {}; // seg → html between its marker and the next one
  markers.forEach((mk, i) => {
    const html = body.slice(mk.end, i + 1 < markers.length ? markers[i + 1].start : body.length);
    between[mk.seg] = html;
    const first = html.match(/^\s*<p[^>]*>([\s\S]*?)<\/p>/);
    if (first && (first[1].match(/<iframe/g) || []).length > 1) packed.add(mk.seg);
  });

  const segTracks = {};
  const loose = []; // tracks not under any heading — every track of a year-end list
  for (const t of tracks) {
    for (const s of t.shows || []) {
      if (s.slug !== rec.slug) continue;
      const row = {
        key: t.key, title: t.title || '', artist: t.artist || '', artists: Array.isArray(t.artists) ? t.artists : null,
        labels: (s.labels || []).slice(), link: t.link || '', artUrl: t.artUrl || '', kind: t.kind || '',
        src: decode(t.embedSrc || ''), // its player on the page
      };
      if (s.seg == null || !markers.some((mk) => mk.seg === s.seg)) { if (!loose.some((x) => x.key === row.key)) loose.push(row); continue; }
      (segTracks[s.seg] = segTracks[s.seg] || []).push(row);
      if (editedSegs.has(s.seg)) continue;
      if (!PLACEHOLDER_ARTIST.test(String(t.artist || '').trim()) && (!artistHeadingSegs.has(s.seg) || packed.has(s.seg))) add(arts, s.seg, t.artist);
      (s.labels || []).forEach((l) => add(labs, s.seg, l));
    }
  }

  // a heading's tracks in the order their players have on the page (the track index has
  // its own order); a track without a player there goes last
  Object.keys(segTracks).forEach((seg) => {
    const order = players[seg] || [];
    const used = new Set();
    const pos = new Map(segTracks[seg].map((row) => {
      const i = order.findIndex((src, k) => src === row.src && !used.has(k));
      used.add(i);
      return [row, i < 0 ? Infinity : i];
    }));
    segTracks[seg].sort((a, b) => pos.get(a) - pos.get(b));
  });

  const headings = markers.map((mk) => ({
    seg: mk.seg,
    text: plainText(mk.inner),
    edited: editedSegs.has(mk.seg),
    hasContent: !/^\s*$/.test(between[mk.seg] || ''), // the site's test: is the very next element another heading?
    tracks: segTracks[mk.seg] || [],
    players: players[mk.seg] || [],
  }));
  // Chips, in page order, with the site's empty-heading hand-on.
  headings.forEach((h, i) => {
    let a = arts[h.seg] ? arts[h.seg].slice() : [];
    let l = labs[h.seg] ? labs[h.seg].slice() : [];
    if (a.length > 1) {
      const kept = [], keys = [];
      a.forEach((n) => {
        const k = hardKey(n);
        if (keys.some((kk) => kk === k || (k.length >= 4 && kk.length >= 4 && (kk.indexOf(k) === 0 || k.indexOf(kk) === 0)))) return;
        kept.push(n); keys.push(k);
      });
      a = kept;
    }
    if (a.length && l.length) { const ak = new Set(a.map(hardKey)); l = l.filter((n) => !ak.has(hardKey(n))); }
    h.artists = a; h.labels = l;
    const next = headings[i + 1];
    if (!h.hasContent && next) {
      h.handsOnTo = next.seg;
      a.forEach((n) => add(arts, next.seg, n));
      l.forEach((n) => add(labs, next.seg, n));
    }
  });

  // Tags the record carries without a heading (most scraped shows have some:
  // radioštudent's tag fields, never tied to a heading). The site lists them
  // only in the "all tags" line at the bottom — only those not on a heading anyway.
  const onHeadings = new Set(headings.flatMap((h) => [...h.artists, ...h.labels]).map(hardKey));
  const untiedOf = (list) => [...new Set(list.filter((t) => t.seg == null && t.name && !onHeadings.has(hardKey(t.name))).map((t) => t.name))];
  return { headings, looseTracks: loose, untied: { artists: untiedOf(rec.artists || []), labels: untiedOf(rec.labels || []) } };
}

const recordTitle = (r) => r.title || r.slug;

// ---- local preview of the built site (docs/) --------------------------------
// GitHub Pages serves docs/ and answers any unknown path with 404.html, whose
// script turns /modem-249 into /?/modem-249 for the single-page app — the same
// fallback here makes show URLs work exactly as they do on the live site.
let previewServer = null;
function ensurePreview(port) {
  if (previewServer) return Promise.resolve(previewServer.port);
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(express.static(DOCS_DIR, { etag: false, lastModified: false, cacheControl: false }));
    app.use((req, res) => res.status(404).sendFile(path.join(DOCS_DIR, '404.html')));
    const srv = app.listen(port, '127.0.0.1', () => { previewServer = { srv, port }; resolve(port); });
    srv.on('error', reject);
  });
}

function mount(app, opts = {}) {
  const previewPort = opts.previewPort || 8091;

  // ---------- /site/records — every show + year-end list, for the picker ----
  app.get('/site/records', (req, res) => {
    try {
      const out = (getArchive().records || []).map((r) => ({
        slug: r.slug, type: r.type, number: r.number || null, title: recordTitle(r), date: r.date || '',
        segs: (r.segments || []).length,
      }));
      out.sort((a, b) => (a.type === b.type ? (b.number || 0) - (a.number || 0) || a.title.localeCompare(b.title) : a.type === 'show' ? -1 : 1));
      res.json({ ok: true, records: out });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /site/record?slug= — one record's headings, chips, tracks ------
  app.get('/site/record', (req, res) => {
    try {
      const data = getArchive();
      const rec = (data.records || []).find((r) => r.slug === String(req.query.slug || ''));
      if (!rec) return res.status(404).json({ ok: false, error: 'no show or list called ' + req.query.slug });
      const { headings, looseTracks, untied } = headingsFor(rec, data.tracks || []);
      res.json({
        ok: true,
        record: {
          slug: rec.slug, type: rec.type, number: rec.number || null, title: recordTitle(rec), date: rec.date || '',
          cover: rec.cover || '', source: rec.url || '', origin: rec.origin || 'scraped',
          liveUrl: LIVE_SITE + '/' + rec.slug,
        },
        headings, looseTracks, untied,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /site/pending — saved edits that aren't on the site yet -------
  // "On the site" = in the last commit (every publish commits + pushes them).
  app.get('/site/pending', (req, res) => {
    try {
      const root = path.join(__dirname, '..');
      const committed = (rel) => { try { return execFileSync('git', ['show', 'HEAD:' + rel], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch (e) { return ''; } };
      const working = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch (e) { return ''; } };
      const parse = (s) => { try { return JSON.parse(s); } catch (e) { return {}; } };
      const before = parse(committed('src/assets/overrides.json')), now = parse(working('src/assets/overrides.json'));
      const changedKeys = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
      const segSet = new Set();
      for (const field of ['segEdits', 'orderEdits']) { // a heading's tags, or its moved tracks
        for (const slug of changedKeys(before[field], now[field])) {
          changedKeys((before[field] || {})[slug], (now[field] || {})[slug]).forEach((seg) => segSet.add(slug + '::' + seg));
        }
      }
      const segs = [...segSet];
      const merges = changedKeys(before.tagMerges, now.tagMerges);
      const edits = changedKeys(before.tagEdits, now.tagEdits);
      const sc = changedKeys(parse(committed('scripts/approvals.json')), parse(working('scripts/approvals.json')));
      // the Tracklist tab's start-time fixes ("<slug>::<rowId>")
      const times = changedKeys(before.timeEdits, now.timeEdits);
      const timeShows = new Set(times.map((k) => k.split('::')[0])).size;
      res.json({
        ok: true, segEdits: segs, tagMerges: merges.length, tagEdits: edits, scLinks: sc.length,
        timeEdits: times.length, timeShows,
        total: segs.length + merges.length + edits.length + sc.length + times.length,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /site/preview — start (once) the local copy of the built site --
  app.post('/site/preview', async (req, res) => {
    try {
      if (!fs.existsSync(path.join(DOCS_DIR, 'index.html'))) return res.status(400).json({ ok: false, error: 'the site has not been built on this computer yet' });
      const port = await ensurePreview(previewPort);
      res.json({ ok: true, base: `http://localhost:${port}` });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'could not start the preview: ' + String(e.message || e) });
    }
  });
}

module.exports = { mount, headingsFor };
