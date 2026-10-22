// Links for the names on the year-end list, the way the published lists have them: the
// artist's and the label's SoundCloud profiles, mostly (the 2025 list: 73 SoundCloud links,
// 1 Bandcamp). The site makes the tag pills from the same line ("Artist - Title (Label)",
// see src/archive.html), so the links don't change the pills — only where a name leads.
//
// For each name, in order:
//   1. the link Matej used for that name on an earlier list (any name of a "same artist")
//   2. the release's Bandcamp page → the SoundCloud account in its links box — the artist's
//      when the page is the artist's own, the label's when it's the label's page
//   3. a SoundCloud release → the uploader's profile, when the uploader is that artist / label
//   4. the Bandcamp page itself (artist's own / the label's)
// Platform links (2–4) only for a name as found; a name fixed by hand gets 1 or nothing.
// A link typed into the ✎ editor wins over all of these.
const { bcPage, scGet, scCached } = require('./year-end-releases');

// A SoundCloud profile by name — only when exactly one account has exactly that name (case,
// accents, spaces aside) and has uploads; several with that name = no link (better none than
// a wrong one). Checked on the 2025 list's missing links: 4 right, 1 the artist's own profile
// where Matej had linked the label's, 11 left empty. Cached per name.
function soundcloudByName(name) {
  const key = spelled(name);
  if (!key || /^(v\/a|self-released)$/.test(key)) return null;
  try {
    return scCached('ye-sc-user-' + key.replace(/[^\p{L}\p{N}]+/gu, '_').slice(0, 80), () => {
      const j = scGet('/search/users?q=' + encodeURIComponent(name) + '&limit=50') || {};
      const exact = (j.collection || []).filter((u) => spelled(u.username) === key && (u.track_count || 0) > 0);
      return exact.length === 1 ? exact[0].permalink_url : null;
    });
  } catch (e) { return null; }
}

const spelled = (s) => String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();
const decode = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#0*39;/g, "'").replace(/&quot;/g, '"')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
const dateKey = (d) => { const m = String(d || '').match(/(\d+)\.\s*(\d+)\.\s*(\d{4})/); return m ? Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]) : 0; };

// name → link, from every published list (a newer list wins)
function knownLinks(archive) {
  const artists = new Map(), labels = new Map();
  const lists = (archive.records || []).filter((r) => r.type === 'list').sort((a, b) => dateKey(a.date) - dateKey(b.date));
  for (const r of lists) {
    for (const m of String(r.bodyHtml || '').matchAll(/<p>([\s\S]*?)<\/p>/g)) {
      const p = m[1];
      if (/<iframe|EmbeddedPlayer|&amp;lt;/.test(p)) continue;
      const a = p.match(/^\s*<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>(?:\s|&nbsp;)*[-–—]/);
      if (a && !/^(v\.?\s?\/?\s?a\.?|various\s+artists?)$/i.test(decode(a[2]))) artists.set(spelled(decode(a[2])), a[1]);
      const l = p.match(/\((?:\s|&nbsp;)*<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>(?:\s|&nbsp;)*\)(?:\s|&nbsp;)*$/);
      if (l) labels.set(spelled(decode(l[2])), l[1]);
    }
  }
  return { artists, labels };
}

// The SoundCloud account a Bandcamp page links to — from the page's own links box first
// (the first SoundCloud link anywhere can be a guest credited in the album's notes).
const NON_ACCOUNT = /^(pages|discover|stream|search|you|upload|settings|tags|people|charts|mobile|imprint|popular|terms|jobs|help|player|oembed)$/i;
function soundcloudOn(bcUrl) {
  if (!bcUrl) return null;
  let html = '';
  try { html = bcPage(bcUrl) || ''; } catch (e) { return null; }
  const box = (html.match(/<ol id="band-links"[\s\S]*?<\/ol>/) || [])[0];
  for (const part of [box, html]) {
    for (const raw of String(part || '').match(/soundcloud\.com\/([A-Za-z0-9_-]+)/g) || []) {
      const h = raw.split('/')[1];
      if (h && !NON_ACCOUNT.test(h)) return 'https://soundcloud.com/' + h;
    }
  }
  return null;
}

// c = the release as it goes on the list (names fixed by hand applied: year-end.js
// withEdits), orig = as found, edit = the ✎ edit (may carry artistLink / labelLink).
function linksFor(c, orig, edit, known, aliases) {
  const group = new Map();
  (aliases || []).forEach((g) => g.forEach((n) => group.set(spelled(n), g.map(spelled))));
  const fromLists = (map, name) => {
    if (!name) return null;
    for (const k of group.get(spelled(name)) || [spelled(name)]) if (map.has(k)) return map.get(k);
    return null;
  };
  const same = (a, b) => spelled(a) && spelled(a) === spelled(b);
  const asFound = (f) => c[f] === orig[f];
  // a SoundCloud uploader of the release's tracks with that name (or any name of the artist)
  const fromProfiles = (name) => {
    if (!name) return null;
    const names = group.get(spelled(name)) || [spelled(name)];
    const p = (orig.scProfiles || []).find((x) => names.includes(spelled(x.name)));
    return p ? p.url : null;
  };
  let pageOrigin = null;
  try { pageOrigin = new URL(orig.url).origin; } catch (e) { /* no link */ }
  // the first of these that gives a link
  const first = (...tries) => { for (const t of tries) { const v = t(); if (v) return v; } return null; };
  const out = {};

  // the artist ("V/A" never gets a link)
  const ownPage = same(orig.account, orig.artist) && asFound('artist'); // the release is on the artist's own page
  if (edit && edit.artistLink) out.artistUrl = edit.artistLink;
  else if (c.artist === 'V/A') out.artistUrl = null;
  else {
    out.artistUrl = first(
      () => fromLists(known.artists, c.artist),
      () => fromProfiles(c.artist),
      () => (ownPage && orig.source === 'bandcamp' ? soundcloudOn(orig.url) : null),
      () => (ownPage && orig.source === 'soundcloud' ? orig.artistUrl : null), // the uploader
      () => soundcloudByName(c.artist),
      () => (ownPage && orig.source === 'bandcamp' ? pageOrigin : null),
    );
  }

  // the label
  const labelsPage = same(orig.account, c.label); // the release is on the label's page
  if (edit && edit.labelLink) out.labelUrl = edit.labelLink;
  else if (!c.label) out.labelUrl = null;
  else {
    out.labelUrl = first(
      () => fromLists(known.labels, c.label),
      () => fromProfiles(c.label),
      () => (labelsPage && orig.source === 'bandcamp' ? soundcloudOn(orig.url) : null),
      () => (labelsPage && orig.source === 'soundcloud' ? orig.artistUrl : null), // the uploader is the label
      () => soundcloudByName(c.label),
      () => (labelsPage && orig.source === 'bandcamp' ? pageOrigin : null),
    );
  }
  return out;
}

module.exports = { knownLinks, soundcloudOn, linksFor };
