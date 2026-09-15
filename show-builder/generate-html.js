// Build the tracklist HTML block to paste into radioštudent, in the exact
// shape scripts/scrape-modem.js's extractEmbeds()/annotateAndSegment() expect
// once the page is live: a "<p>Name ////...</p>" heading followed by a
// "<p><iframe ...></iframe></p>" embed (the "recent" dialect).
const { curlGet, escapeHtml } = require('./lib');

const SLASHES = '/'.repeat(34);

// Bandcamp's EmbeddedPlayer iframe is fully determined by album/track id —
// no fetch needed, same URL shape already used in src/assets/modem-archive.json
// (see scripts/build-track-index.js's resolveBandcamp()).
function buildBandcampEmbed(item) {
  const parts = ['https://bandcamp.com/EmbeddedPlayer/'];
  if (item.albumId) parts.push(`album=${item.albumId}/`);
  if (item.trackId) parts.push(`track=${item.trackId}/`);
  parts.push('size=large/bgcol=ffffff/linkcol=0687f5/tracklist=false/artwork=small/transparent=true/');
  const src = parts.join('');
  const label = escapeHtml(`${item.title} by ${item.artist}`);
  return `<iframe style="border: 0; width: 350px; height: 470px;" src="${src}" seamless><a href="${escapeHtml(item.url)}">${label}</a></iframe>`;
}

// SoundCloud's iframe is always fetched ready-made via oEmbed — same call
// scripts/scrape-modem.js's resolveSoundcloud() already makes for full shows.
function buildSoundcloudEmbed(item) {
  const oembed = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(item.url)}`;
  const body = curlGet(oembed);
  const data = JSON.parse(body);
  if (!data || !data.html) throw new Error('SoundCloud oEmbed returned no html for ' + item.url);
  return data.html;
}

function buildEmbed(item) {
  if (item.source === 'soundcloud') return buildSoundcloudEmbed(item);
  if (item.source === 'bandcamp-wishlist' || item.source === 'bandcamp-library') return buildBandcampEmbed(item);
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

// items: ordered array of candidate objects (as returned by /scan), already
// filtered/selected/reordered by the user.
function generateShowHtml(items) {
  const blocks = items.map((item) => {
    const heading = `<p>${escapeHtml(headingName(item))} ${SLASHES}</p>`;
    const embed = `<p>${buildEmbed(item)}</p>`;
    return heading + '\n' + embed;
  });
  return blocks.join('\n\n');
}

module.exports = { generateShowHtml, buildBandcampEmbed, buildSoundcloudEmbed };
