/*
 * draft-timestamps.js — a show's live-tracklist timestamps straight from the show
 * builder's Mix tab, so a show published from the draft needs no audio matching.
 *
 * The Mix tab's export renders the timeline from 0:00 with every clip at its `start`
 * (renderMixOffline() in show-builder/public/index.html), and that export is what goes
 * to SoundCloud — so a clip's `start` IS the track's time in the show the site plays.
 *
 *   timestampsFromDraft(draft) -> [{ t, key, title, artist }] in play order, or null
 *     when the draft has no mix (built elsewhere / a machine without the Mix tab's
 *     clips): then the show's timestamps come from matching later
 *     (build_tracklists.py), same as the old shows.
 *   writeShowTimestamps(file, slug, tracks) -> merges { source: "builder", tracks }
 *     into src/assets/show-timestamps.json
 *
 * `key` is the site's track key (modem-archive.json), derived from the same embed the
 * show page gets: "bc:<album|->:<track|->" for Bandcamp, "sc:<id>" for SoundCloud.
 * title/artist ride along for tracks the site can't find by key (a SoundCloud
 * playlist item, a plain-link fallback).
 *
 * Read-only check of the current draft:  node scripts/tracklists/draft-timestamps.js [draft.json]
 */
const fs = require('fs');
const path = require('path');
const { buildBandcampEmbed, namesOf } = require('../../show-builder/generate-html');

const JINGLE_KEY = 'jingle'; // show-builder/public/index.html

function siteKey(item) {
  const k = String(item.key || '');
  if (k.startsWith('bc:') || item.albumId || item.trackId) {
    const src = (buildBandcampEmbed(item).match(/src="([^"]+)"/) || [])[1] || '';
    const alb = (src.match(/album=(\d+)/) || [])[1];
    const trk = (src.match(/track=(\d+)/) || [])[1];
    return alb || trk ? `bc:${alb || '-'}:${trk || '-'}` : null;
  }
  if (k.startsWith('sc:') && !item.isPlaylist) return k;
  return null;
}

function timestampsFromDraft(draft) {
  const clips = (draft && Array.isArray(draft.mixClips) ? draft.mixClips : [])
    .filter((c) => c && c.key !== JINGLE_KEY && !c.muted && Number.isFinite(c.start));
  if (!clips.length) return null;
  const out = [];
  for (const item of draft.selected || []) {
    // an item with several downloaded files has a clip per file ("<key>:0", "<key>:1"…);
    // the track starts where its first clip does
    const mine = clips.filter((c) => c.key === item.key || String(c.key).startsWith(item.key + ':'));
    if (!mine.length) continue;
    const t = Math.min(...mine.map((c) => c.start));
    out.push({
      t: Math.round(t * 10) / 10,
      key: siteKey(item),
      title: item.title || '',
      artist: (namesOf(item, 'artist') || []).join(' & ') || item.artist || '',
    });
  }
  out.sort((a, b) => a.t - b.t);
  return out.length ? out : null;
}

function writeShowTimestamps(file, slug, tracks) {
  let data = { version: 1, shows: {} };
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first one */ }
  data.shows = data.shows || {};
  data.shows[slug] = {
    source: 'builder',
    tracks: tracks.map((x) => {
      const o = { t: x.t };
      if (x.key) o.key = x.key;
      if (x.title) o.title = x.title;
      if (x.artist) o.artist = x.artist;
      return o;
    }),
  };
  fs.writeFileSync(file, JSON.stringify(data));
}

module.exports = { timestampsFromDraft, writeShowTimestamps, siteKey };

if (require.main === module) {
  const file = process.argv[2] || path.join(__dirname, '..', '..', 'show-builder', 'data', 'current-draft.json');
  const draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ts = timestampsFromDraft(draft);
  console.log(`${path.basename(file)}: show ${draft.showNumber}, ${(draft.selected || []).length} tracks, ${(draft.mixClips || []).length} mix clips`);
  if (!ts) { console.log('no mix in this draft — timestamps would come from matching later'); process.exit(0); }
  for (const x of ts) {
    const m = Math.floor(x.t / 60), s = (x.t % 60).toFixed(1).padStart(4, '0');
    console.log(`  ${String(m).padStart(3)}:${s}  ${(x.key || '(by name)').padEnd(26)} ${x.artist} - ${x.title}`);
  }
}
