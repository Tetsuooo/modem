/*
 * fix-missing-segments.js — two shows (modem-224, modem-195) have real tracks
 * whose heading never got a "///// [name]" slash-marker from the scraper (the
 * source page just has a bare name paragraph with no slash run at all, a third
 * heading dialect annotateAndSegment() doesn't parse), so those tracks render
 * chip-less/pencil-less. This is a hand-verified, one-off renumbering — NOT a
 * general parser fix — kept here (rather than as a direct edit to
 * modem-archive.json) because scrape-modem.js --reparse regenerates that file
 * from the cached source on every admin save (see server.js /save-overrides),
 * which would silently wipe a direct edit. Called from apply-overrides.js,
 * BEFORE tagMerges/tagEdits/segEdits are applied, so admin edits always land
 * against this corrected numbering, not the stale pre-fix one.
 *
 * Idempotent: skips a show if its segments.length already matches the target
 * (safe to call on every apply-overrides.js run, migrated or not).
 */

function must(hay, needle, label) {
  const count = hay.split(needle).length - 1;
  if (count !== 1) throw new Error('fix-missing-segments: expected exactly 1 occurrence of [' + label + '], found ' + count);
  return needle;
}

function renumberDataSegs(bodyHtml, oldToNew) {
  let out = bodyHtml;
  for (const [oldN, newN] of Object.entries(oldToNew)) {
    const from = 'data-seg="' + oldN + '"';
    must(out, from, 'data-seg=' + oldN);
    out = out.replace(from, 'data-seg="__NEW_' + newN + '__"');
  }
  return out.replace(/data-seg="__NEW_(\d+)__"/g, 'data-seg="$1"');
}

function promoteOrphan(bodyHtml, bareText, newSeg) {
  const from = '<p>' + bareText + '</p>';
  must(bodyHtml, from, 'orphan <p>' + bareText + '</p>');
  const to = '<p data-seg="' + newSeg + '" class="seg-marker">' + bareText + ' ///////</p>';
  return bodyHtml.replace(from, to);
}

function insertHeadingBefore(bodyHtml, anchorSubstr, headingText, newSeg, label) {
  must(bodyHtml, anchorSubstr, label);
  const marker = '<p data-seg="' + newSeg + '" class="seg-marker">' + headingText + ' ///////</p>';
  return bodyHtml.replace(anchorSubstr, marker + anchorSubstr);
}

// Renumber every rec.artists/rec.labels entry whose .seg matches a key in
// oldToNew — two-phase (capture every match FIRST, apply new values only
// after) so it's safe even where old and new seg spaces overlap (e.g.
// modem-224's old seg 0 and new seg 0 are different tracks entirely; applying
// in one pass could make a later lookup match an entry a prior step just
// renumbered INTO that slot instead of the one originally there). Looked up
// by seg number, not name, so a combining-character name (e.g. modem-224's
// "digital selves", written with a combining mark under every letter) can't
// silently fail to match after a re-normalizing round trip through the
// scrape/build pipeline the way a hardcoded name literal could.
function renumberBySeg(list, oldToNew) {
  const matches = [];
  for (const entry of list) {
    if (entry.seg != null && Object.prototype.hasOwnProperty.call(oldToNew, entry.seg)) {
      matches.push([entry, oldToNew[entry.seg]]);
    }
  }
  for (const [entry, newSeg] of matches) entry.seg = newSeg;
}

function applyArtistSeg(rec, name, newSeg) {
  const a = rec.artists.find((x) => x.name === name);
  if (!a) throw new Error('fix-missing-segments: artist not found: ' + name);
  a.seg = newSeg;
}
function applyLabelSeg(rec, name, newSeg) {
  const l = rec.labels.find((x) => x.name === name);
  if (!l) throw new Error('fix-missing-segments: label not found: ' + name);
  l.seg = newSeg;
}
// Same combining-character fragility as applyArtistSegByOldSeg, but for a
// brand-new label with no prior seg to key off — modem-195's "Summon" label is
// scraped as "s̶͈̓̏̀̇̈̎͊̓͝ummon" (decorative strikethrough/combining marks from the
// label's own stylized bandcamp handle), which doesn't survive being retyped
// as a literal. Its radiostudent taxonomy URL is plain ASCII and stable.
function applyLabelSegByUrl(rec, url, newSeg) {
  const l = rec.labels.find((x) => x.url === url);
  if (!l) throw new Error('fix-missing-segments: no label with url ' + url);
  l.seg = newSeg;
}
function applyTrackSeg(tracks, slug, key, newSeg) {
  const t = tracks.find((x) => x.key === key);
  if (!t) throw new Error('fix-missing-segments: track not found: ' + key);
  const s = (t.shows || []).find((x) => x.slug === slug);
  if (!s) throw new Error('fix-missing-segments: track ' + key + ' has no shows[] entry for ' + slug);
  s.seg = newSeg;
}

function migrate224(data) {
  const rec = data.records.find((r) => r.slug === 'modem-224');
  if (!rec || rec.segments.length === 19) return; // already applied (or show missing)
  const oldToNew = { 0: 2, 1: 4, 2: 5, 3: 7, 4: 8, 5: 9, 6: 11, 7: 12 };
  let body = renumberDataSegs(rec.bodyHtml, oldToNew);

  // "wwartime investor" is deliberately left un-promoted (no data-seg) — it has
  // no embed of its own at all (sits directly between хмора's credit div and
  // scatnigga's real marker), so giving it a real seg makes it a target for
  // archive.html's ghost-marker merge (a numbered marker with nothing before
  // the next marker), which then wrongly folds its chip onto scatnigga's
  // unrelated segment. Numbering below skips straight from 10 to 11 with no
  // gap — rec.segments is positional (segments[N] == data-seg="N", see
  // build-track-index.js's segLabels[seg] lookup) so a reserved-but-empty slot
  // would break that.
  const orphans = [
    ['Portraiture', 0], ['Huar Huarco', 1], ["새눈도둑 Bird's Eye Thief", 3],
    ['eeeeeeeeeeeeeeeeeeeeeeeev', 6], ['хмора', 10],
    ['luv exposure', 13], ['Other People', 14], ['志見祥', 15], ['surf', 16],
    ['SVBKVLT', 17], ['PACIFIC CITY SOUND VISIONS', 18],
  ];
  for (const [text, seg] of orphans) body = promoteOrphan(body, text, seg);
  rec.bodyHtml = body;

  // Renumber the 7 pre-existing (already-marked) segments by seg number.
  renumberBySeg(rec.artists, oldToNew);

  // Newly-promoted orphans: no prior seg, so name lookup is the only option
  // (these are all plain ASCII/CJK/Cyrillic — no combining marks, safe).
  applyArtistSeg(rec, 'Huar Huarco', 1);
  applyArtistSeg(rec, "새눈도둑 Bird's Eye Thief", 3);
  applyArtistSeg(rec, 'eeeeeeeeeeeeeeeeeeeeeeeev', 6);
  applyArtistSeg(rec, 'хмора', 10);
  applyArtistSeg(rec, '志見祥', 15);

  applyLabelSeg(rec, 'Portraiture', 0);
  applyLabelSeg(rec, 'other people', 14);
  applyLabelSeg(rec, 'surf', 16);
  applyLabelSeg(rec, 'SVBKVLT', 17);
  applyLabelSeg(rec, 'Pacific City Sound Visions', 18);

  const tracks = data.tracks;
  applyTrackSeg(tracks, 'modem-224', 'bc:3965648941:1724326288', 0); // gronos1
  applyTrackSeg(tracks, 'modem-224', 'bc:3965648941:3369526915', 0); // music lovers anonymous
  applyTrackSeg(tracks, 'modem-224', 'bc:3965648941:51085238', 0);   // gibby
  applyTrackSeg(tracks, 'modem-224', 'bc:3965648941:258894628', 0);  // wish
  applyTrackSeg(tracks, 'modem-224', 'bc:1362642352:3225532341', 1); // Huar Huarco
  applyTrackSeg(tracks, 'modem-224', 'sc:2194578363', 2);            // YNO
  applyTrackSeg(tracks, 'modem-224', 'bc:701408169:-', 3);           // 새눈도둑
  applyTrackSeg(tracks, 'modem-224', 'sc:2068968152', 4);            // ᵗ-ˢᶜ³囧
  applyTrackSeg(tracks, 'modem-224', 'sc:2191501023', 5);            // guu
  applyTrackSeg(tracks, 'modem-224', 'bc:687470746:1374043678', 6);  // eeeeeeeeeeeeeeeeeeeeeeeev
  applyTrackSeg(tracks, 'modem-224', 'sc:2195075147', 7);            // bathroom0167259603
  applyTrackSeg(tracks, 'modem-224', 'sc:2195120595', 8);            // digital selves
  applyTrackSeg(tracks, 'modem-224', 'sc:204356307', 9);             // daily sound collection
  applyTrackSeg(tracks, 'modem-224', 'sc:2189271575', 10);           // хмора
  // seg 11 (scatnigga): no matching track (malformed embed URL, separate known
  // issue) — renumber the marker only, leave chip-less as before.
  applyTrackSeg(tracks, 'modem-224', 'sc:2192545279', 12);           // smile gang
  applyTrackSeg(tracks, 'modem-224', 'bc:-:4234275907', 13);         // luv exposure (no taxonomy entry; relies on fallback)
  applyTrackSeg(tracks, 'modem-224', 'bc:3957838351:2118202340', 14);// aylu (Other People)
  applyTrackSeg(tracks, 'modem-224', 'sc:2198938383', 15);           // 志見祥
  applyTrackSeg(tracks, 'modem-224', 'bc:3648547756:1230920239', 16);// Sardinas (surf)
  applyTrackSeg(tracks, 'modem-224', 'bc:2959533886:2000278892', 17);// ABADIR (SVBKVLT)
  applyTrackSeg(tracks, 'modem-224', 'bc:3994734511:-', 18);         // LORENZO'S OIL (Pacific City Sound Visions)

  rec.segments = [
    'Portraiture', 'Huar Huarco', 'YNO', "새눈도둑 Bird's Eye Thief", 'ᵗ-ˢᶜ³囧', 'guu',
    'eeeeeeeeeeeeeeeeeeeeeeeev', 'bathroom0167259603', 'd͓̽i͓̽g͓̽i͓̽t͓̽a͓̽l͓̽ ͓̽s͓̽e͓̽l͓̽v͓̽e͓̽s͓̽',
    'daily sound collection', 'хмора', 'scatnigga', 'smile gang',
    'luv exposure', 'Other People', '志見祥', 'surf', 'SVBKVLT', 'PACIFIC CITY SOUND VISIONS',
  ];
}

function migrate195(data) {
  const rec = data.records.find((r) => r.slug === 'modem-195');
  if (!rec || rec.segments.length === 16) return; // already applied (or show missing)
  const oldToNew = { 0: 1, 1: 6, 2: 8, 3: 9, 4: 10, 5: 11, 6: 12, 7: 13 };
  let body = renumberDataSegs(rec.bodyHtml, oldToNew);

  const orphans = [
    ['Orange Milk', 0], ['julek ploski', 2], ['Genome 6.66Mbp', 4], ['katharsis', 5],
    ['djsn3s', 7], ['dzhan lia bless (elsie جان lappoh)', 14], ['Dj Roadrunner', 15],
  ];
  for (const [text, seg] of orphans) body = promoteOrphan(body, text, seg);

  // The "Summon" compilation (3 packed Bandcamp iframes) has no heading text at
  // all in the source — insert one, anchored on its first iframe's unique src.
  body = insertHeadingBefore(
    body,
    '<p><iframe src="https://bandcamp.com/EmbeddedPlayer/album=1245224171/size=small/bgcol=ffffff/linkcol=0687f5/track=4277839017/transparent=true/">',
    'Summon', 3, 'Summon compilation anchor'
  );
  rec.bodyHtml = body;

  // Renumber the 8 pre-existing (already-marked) segments by seg number.
  renumberBySeg(rec.artists, oldToNew);

  // Newly-promoted orphans: no prior seg, so name lookup is the only option.
  applyArtistSeg(rec, 'julek ploski', 2);
  applyArtistSeg(rec, 'Soli City', 3);
  applyArtistSeg(rec, 'vio lino', 3);
  applyArtistSeg(rec, 'Yinawe', 3);
  applyArtistSeg(rec, 'Charity Ssb', 4);
  applyArtistSeg(rec, 'icfam', 5);
  applyArtistSeg(rec, 'djsn3s', 7);
  applyArtistSeg(rec, 'dzhan lia bless', 14);
  applyArtistSeg(rec, 'DJ Roadrunner', 15);

  applyLabelSeg(rec, 'Orange Milk', 0);
  applyLabelSegByUrl(rec, 'https://radiostudent.si/institucije/summon-0', 3);
  applyLabelSeg(rec, 'Genome 6.66Mbp', 4);
  applyLabelSeg(rec, 'katharsis', 5);
  applyLabelSeg(rec, 'Cartajena Ink', 15);

  const tracks = data.tracks;
  applyTrackSeg(tracks, 'modem-195', 'bc:2178181219:3683146457', 0); // galen tipton & Holly Waxwing
  applyTrackSeg(tracks, 'modem-195', 'bc:4177817188:2785613409', 0); // ---__--____
  applyTrackSeg(tracks, 'modem-195', 'sc:1897296621', 1);            // Laenip
  applyTrackSeg(tracks, 'modem-195', 'bc:-:2840562765', 2);          // Julek ploski
  applyTrackSeg(tracks, 'modem-195', 'bc:1245224171:4277839017', 3); // Soli City
  applyTrackSeg(tracks, 'modem-195', 'bc:1245224171:1550984862', 3); // vio lino
  applyTrackSeg(tracks, 'modem-195', 'bc:1245224171:2991234967', 3); // Yinawe
  applyTrackSeg(tracks, 'modem-195', 'bc:2937534911:360839206', 4);  // Charity SsB
  applyTrackSeg(tracks, 'modem-195', 'bc:2303240568:3330367065', 5); // icfam
  applyTrackSeg(tracks, 'modem-195', 'sc:1904286527', 6);            // ❌ Videoplay back 、
  applyTrackSeg(tracks, 'modem-195', 'bc:4189523187:640531541', 7);  // djsn3s
  applyTrackSeg(tracks, 'modem-195', 'sc:1903813934', 8);            // 100%sweetㅤ҉ㅤ⠀꩜cafe
  applyTrackSeg(tracks, 'modem-195', 'sc:1899063144', 9);            // Alley Catss
  applyTrackSeg(tracks, 'modem-195', 'sc:1903784888', 10);           // tibslc
  applyTrackSeg(tracks, 'modem-195', 'sc:1897370298', 11);           // egoseed
  applyTrackSeg(tracks, 'modem-195', 'sc:1905838046', 12);           // zero margin vol2
  // seg 13 (serpuline) / 14 (dzhan lia bless): no track entry — taxonomy carries them.
  applyTrackSeg(tracks, 'modem-195', 'bc:-:1147893201', 15);         // Dj Roadrunner

  rec.segments = [
    'Orange Milk', 'Laenip', 'julek ploski', 'Summon', 'Genome 6.66Mbp', 'katharsis',
    '❌ Videoplay back 、', 'djsn3s', '100%sweetㅤ҉ㅤ⠀꩜cafe', 'Alley Catss', 'tibslc',
    'egoseed', 'zero margin vol2', 'serpuline', 'dzhan lia bless (elsie جان lappoh)', 'Dj Roadrunner',
  ];
}

function applySegMarkerFixes(data) {
  migrate224(data);
  migrate195(data);
}

module.exports = { applySegMarkerFixes };
