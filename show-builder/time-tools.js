// "Tracklist" tab, server half — set the live tracklist's start times by hand for
// tracks the audio matching couldn't place (or placed wrong), while listening to
// the show (public/timestamps.js).
//
// Reads src/assets/show-timestamps.json (the site's data: matching results, shows
// timed by the Mix tab) and saves the fixes into src/assets/overrides.json →
// "timeEdits" ("<slug>::<rowId>": seconds | false) — merged into the file as it is
// on disk, so it can't overwrite tag edits saved meanwhile. Like the tag edits they
// reach the site with "Publish site edits" (or a show publish), whose pipeline runs
// scripts/tracklists/apply-timestamp-edits.js.
const fs = require('fs');
const path = require('path');
const { getArchive, getOverrides, writeJsonAtomic, OVERRIDES_FILE } = require('./archive-cache');
const { rowId, applyToShow, editsBySlug } = require('../scripts/tracklists/apply-timestamp-edits');

const TIMESTAMPS = path.join(__dirname, '..', 'src', 'assets', 'show-timestamps.json');
const readTimestamps = () => { try { return JSON.parse(fs.readFileSync(TIMESTAMPS, 'utf8')).shows || {}; } catch (e) { return {}; } };

// the rows as matching / the builder made them (any previously applied fix undone)
const baseRows = (tracks) => applyToShow(tracks, {}).tracks;

function mount(app) {
  // ---------- /times/shows — every show with a tracklist, how many are estimated ----
  app.get('/times/shows', (req, res) => {
    try {
      const shows = readTimestamps();
      const edits = editsBySlug(getOverrides().timeEdits);
      const recs = new Map((getArchive().records || []).map((r) => [r.slug, r]));
      const list = Object.entries(shows).map(([slug, s]) => {
        const rows = baseRows(s.tracks);
        const rec = recs.get(slug) || {};
        return {
          slug, number: rec.number || null, date: rec.date || '', source: s.source || '',
          tracks: rows.length, estimated: rows.filter((x) => x.approx).length,
          edited: Object.keys(edits[slug] || {}).length,
        };
      }).sort((a, b) => (b.number || 0) - (a.number || 0));
      res.json({ ok: true, shows: list });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /times/show?slug= — one show's rows + what's needed to play it ----
  app.get('/times/show', (req, res) => {
    try {
      const slug = String(req.query.slug || '');
      const s = readTimestamps()[slug];
      if (!s) return res.status(404).json({ ok: false, error: 'no tracklist for ' + slug });
      const archive = getArchive();
      const rec = (archive.records || []).find((r) => r.slug === slug) || {};
      const byKey = new Map((archive.tracks || []).map((t) => [t.key, t]));
      const rows = baseRows(s.tracks).map((x) => {
        const tk = (x.key && byKey.get(x.key)) || {};
        return {
          id: rowId(x), auto: x.t, approx: !!x.approx, key: x.key || null,
          title: tk.title || x.title || 'untitled', artist: tk.artist || x.artist || '', art: tk.artUrl || '',
        };
      });
      res.json({
        ok: true, slug, number: rec.number || null, date: rec.date || '', source: s.source || '',
        soundcloud: rec.soundcloud || null, rows, edits: editsBySlug(getOverrides().timeEdits)[slug] || {},
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /times/save — this show's fixes, replacing its previous ones ----
  // body: { slug, edits: { rowId: seconds | false } }
  app.post('/times/save', (req, res) => {
    const { slug, edits } = req.body || {};
    if (!slug || !/^[\w-]+$/.test(slug) || !edits || typeof edits !== 'object') {
      return res.status(400).json({ ok: false, error: 'need { slug, edits }' });
    }
    try {
      const o = getOverrides(); // fresh from disk — tag edits saved meanwhile stay
      const te = { ...(o.timeEdits || {}) };
      for (const k of Object.keys(te)) if (k.startsWith(slug + '::')) delete te[k];
      let n = 0;
      for (const [id, v] of Object.entries(edits)) {
        if (v === false || (typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
          te[slug + '::' + id] = v === false ? false : Math.round(v * 10) / 10; n++;
        }
      }
      o.timeEdits = te;
      writeJsonAtomic(OVERRIDES_FILE, o);
      res.json({ ok: true, saved: n });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
}

module.exports = { mount };
