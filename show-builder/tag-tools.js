// Tag-cleanup routes for the show builder — the local half of src/admin.html
// (the "tag merge" and "edit tags" tabs), so doubled artist/label tags can be
// found and merged from the same tool the show is built in.
//
// The edits live in src/assets/overrides.json (committed; schema documented in
// scripts/apply-overrides.js). Saving writes ONLY that file. The site's data
// picks the edits up at the next publish, whose pipeline always ends with
// apply-overrides.js — and, when an edit was taken back since the last publish,
// first re-derives the archive from source (see server.js /publish-run and
// scripts/overrides-diff.js). The archive itself is therefore only ever changed by
// a publish and pushed straight after; left modified for days it would make
// every Sync's `git pull` fail as soon as the automatic GitHub update commits its own copy.
const { getArchive, getOverrides, writeJsonAtomic, OVERRIDES_FILE } = require('./archive-cache');
// Does a save TAKE BACK something already applied? (see scripts/overrides-diff.js)
const { undoesSomething } = require('../scripts/overrides-diff');

function mount(app) {
  // ---------- /tags/summary — every artist/label tag with its use count ----
  // Counted per occurrence on the show/list records (what the site's chips and
  // search read), so the numbers match what admin.html showed.
  app.get('/tags/summary', (req, res) => {
    try {
      const artists = {}, labels = {};
      for (const r of getArchive().records || []) {
        for (const x of r.artists || []) artists[x.name] = (artists[x.name] || 0) + 1;
        for (const x of r.labels || []) labels[x.name] = (labels[x.name] || 0) + 1;
      }
      res.json({ ok: true, artists, labels, overrides: getOverrides() });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /tags/tracks?q= — find a release to edit its tags ------------
  app.get('/tags/tracks', (req, res) => {
    try {
      const terms = String(req.query.q || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
      if (!terms.length) return res.json({ ok: true, tracks: [] });
      const hits = [];
      for (const t of getArchive().tracks || []) {
        const hay = ((t.title || '') + ' ' + (t.artist || '') + ' ' + (t.album || '') + ' ' +
          (t.shows || []).map((s) => 'modem ' + s.number).join(' ')).toLowerCase();
        if (!terms.every((x) => hay.includes(x))) continue;
        hits.push({
          key: t.key, title: t.title || '', artist: t.artist || '', artUrl: t.artUrl || '',
          shows: (t.shows || []).map((s) => ({ type: s.type, slug: s.slug, number: s.number })),
          labels: [...new Set((t.shows || []).flatMap((s) => s.labels || []))],
        });
        if (hits.length >= 30) break;
      }
      res.json({ ok: true, tracks: hits });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });

  // ---------- /tags/save — write overrides.json -----------------------------
  app.post('/tags/save', (req, res) => {
    const o = req.body && req.body.overrides;
    if (!o || typeof o !== 'object' || typeof o.tagMerges !== 'object') {
      return res.status(400).json({ ok: false, error: 'overrides must be an object with a tagMerges map' });
    }
    try {
      writeJsonAtomic(OVERRIDES_FILE, o);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  });
}

module.exports = { mount, undoesSomething };
