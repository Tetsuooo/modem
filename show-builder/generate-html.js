// Build the tracklist HTML block to paste into radioštudent, in the exact
// shape scripts/scrape-modem.js's extractEmbeds()/annotateAndSegment() expect
// once the page is live: a "<p>Name ////...</p>" heading followed by a
// "<p><iframe ...></iframe></p>" embed (the "recent" dialect).
const { curlGet, escapeHtml } = require('./lib');

const SLASHES = '/'.repeat(34);

// Bandcamp's EmbeddedPlayer iframe is fully determined by album/track id —
// no fetch needed, same URL shape already used in src/assets/modem-archive.json
// (see scripts/build-track-index.js's resolveBandcamp()).
//
// Deliberately NO inline style/width/height/seamless attribute — checked
// against real already-published modem posts (grepped modem-archive.json's
// bodyHtml) and every one is a bare `<iframe src="...">`, sized entirely by
// whatever page displays it (the archive site's own `.modem-body
// iframe[src*="bandcamp"] { height: 120px }`, see src/archive.html). An
// earlier version of this hardcoded `style="...height: 470px"` (a size only
// correct for tracklist=true, not the tracklist=false used here), which
// overrode that 120px rule via inline-style specificity and left a big
// empty gap under the actual compact widget — both in this tool's own
// Preview tab and, since that's literally the HTML pasted into
// radioštudent, on the real published show page too.
// `small`: when several tracks off the SAME release share one heading (see
// groupRuns()), each gets the SMALL Bandcamp player instead of the large
// one — confirmed against real precedent (modem-242's "Cold Storage",
// modem-246's "mappa"): every real multi-track group in the archive uses
// `size=small` (no tracklist/artwork params — Bandcamp's small size
// doesn't have room for either), never several large players stacked.
// Large stays the default for a single standalone track.
function buildBandcampEmbed(item, opts) {
  const small = !!(opts && opts.small);
  const parts = ['https://bandcamp.com/EmbeddedPlayer/'];
  if (item.albumId) parts.push(`album=${item.albumId}/`);
  parts.push(small ? 'size=small/bgcol=ffffff/linkcol=0687f5/' : 'size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/');
  if (item.trackId) parts.push(`track=${item.trackId}/`);
  parts.push('transparent=true/');
  const src = parts.join('');
  const label = escapeHtml(`${item.title} by ${item.artist}`);
  return `<iframe src="${src}"><a href="${escapeHtml(item.url)}">${label}</a></iframe>`;
}

// SoundCloud's iframe is always fetched ready-made via oEmbed — same call
// scripts/scrape-modem.js's resolveSoundcloud() already makes for full shows.
//
// Some uploaders restrict embedding to themselves (embeddable_by !== 'all'),
// which SoundCloud enforces at the oEmbed API level with no workaround —
// falls back to a plain link instead of failing the whole show, the same
// fallback the live site's own curators already use when an embed isn't
// available (confirmed against the archive: modem-245's "7FO", modem-242's
// "lavi", 140 cases total — all a bare <p><a href="URL">URL</a></p>, no
// iframe). `item.embeddable === false` (set at scan time — see
// scan-soundcloud.js) skips the doomed oEmbed round-trip outright; the
// catch below is defense-in-depth for anything that slips past that flag.
// `small`: same idea as buildBandcampEmbed()'s — several SoundCloud tracks
// off one release sharing a heading get the compact "classic" player
// (visual=false, shorter) instead of the full visual one with its big
// artwork banner, so a multi-track group doesn't stack several tall
// players on radioštudent's own page (the archive site's normalizeEmbeds()
// converts EVERY SoundCloud embed to visual=false at render time anyway,
// so this only actually changes how it looks on radioštudent itself before
// that mirroring happens — see src/archive.html). No real precedent for
// this in the archive (every group so far has been Bandcamp), so this is a
// reasonable default mirroring Bandcamp's, not a confirmed convention.
function buildSoundcloudEmbed(item, opts) {
  const small = !!(opts && opts.small);
  const plainLink = () => `<a href="${escapeHtml(item.url)}">${escapeHtml(item.url)}</a>`;
  if (item.embeddable === false) return plainLink();
  const oembed = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(item.url)}` + (small ? '&maxheight=100' : '');
  const body = curlGet(oembed);
  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    return plainLink();
  }
  if (!data || !data.html) return plainLink();
  return small ? data.html.replace('visual=true', 'visual=false') : data.html;
}

function buildEmbed(item, opts) {
  if (item.source === 'soundcloud') return buildSoundcloudEmbed(item, opts);
  if (item.source === 'bandcamp-wishlist' || item.source === 'bandcamp-library') return buildBandcampEmbed(item, opts);
  throw new Error('unknown item source: ' + item.source);
}

// Real modem show headings are always ONE name — either the artist's or,
// for a label-curated/various-artists post, the label's (radioštudent's own
// convention: e.g. "PHO BHO" as the heading with artists tau contrib +
// Ursula Sereghy tagged separately, vs. "Otto Taimela" as the heading with
// label Cudighi tagged separately) — never both combined in the heading
// text. item.headingSource ('artist'|'label', default 'artist') is that
// per-track editorial choice; the other name still gets its own tag field.
function headingName(item) {
  if (item.headingSource === 'label' && item.label) return item.label;
  return item.artist || item.label || '';
}

// Real modem shows also do this: when several tracks come off the SAME
// release (a Bandcamp album, a various-artists compilation, a SoundCloud
// OST playlist), they share ONE heading followed by one embed per track —
// never a repeated heading per track. Confirmed against the live archive:
// modem-242's "Cold Storage" heading covers 3 tracks off one album, and
// modem-246's "mappa" heading (the LABEL, not any one artist) covers 6
// tracks by 6 different artists off one compilation. show-builder's UI sets
// `groupKey` (shared release id) + `groupHeading` (editable, defaults to the
// release's own artist/label name) on tracks expanded from the same
// album/playlist — see subtrackItem() in public/index.html.
//
// Returns, for each item index, the index it's grouped under: itself if
// standalone or the first item of a run of 2+ adjacent items sharing a
// non-null groupKey, matching that first item's index if it's part of such
// a run, or -1 if ungrouped. (items[i] is "the start of a 2+ run" exactly
// when the return value at i equals i.)
function groupRuns(items) {
  const runOf = new Array(items.length).fill(-1);
  let i = 0;
  while (i < items.length) {
    let j = i;
    while (j + 1 < items.length && items[j + 1].groupKey && items[j + 1].groupKey === items[i].groupKey) j++;
    if (items[i].groupKey && j > i) {
      for (let k = i; k <= j; k++) runOf[k] = i;
    }
    i = j + 1;
  }
  return runOf;
}

// items: ordered array of candidate objects (as returned by /scan), already
// filtered/selected/reordered by the user.
function generateShowHtml(items) {
  const runOf = groupRuns(items);
  const blocks = [];
  let i = 0;
  while (i < items.length) {
    if (runOf[i] === i) {
      // start of a 2+ item group: one shared heading, then one shared <p>
      // holding every track's (small/compact) embed — confirmed against
      // real precedent (modem-242, modem-246): a group's embeds sit
      // space-separated in ONE paragraph, not one <p> each.
      let j = i;
      while (j + 1 < items.length && runOf[j + 1] === i) j++;
      const heading = `<p>${escapeHtml(items[i].groupHeading || headingName(items[i]))} ${SLASHES}</p>`;
      const embeds = [];
      for (let k = i; k <= j; k++) embeds.push(buildEmbed(items[k], { small: true }));
      blocks.push(heading + '\n' + `<p>${embeds.join(' ')}</p>`);
      i = j + 1;
    } else {
      const heading = `<p>${escapeHtml(headingName(items[i]))} ${SLASHES}</p>`;
      const embed = `<p>${buildEmbed(items[i])}</p>`;
      blocks.push(heading + '\n' + embed);
      i++;
    }
  }
  return blocks.join('\n\n');
}

module.exports = { generateShowHtml, buildBandcampEmbed, buildSoundcloudEmbed, groupRuns, headingName };
