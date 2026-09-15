// Preview a draft show exactly the way the live site's own scraper will see
// it, before anything is pasted into radioštudent. Builds a synthetic page
// with the same field wrapper divs scripts/scrape-modem.js's fieldByClass()
// looks for, then runs the REAL parsePage() against it — not a reimplementation.
const { parsePage } = require('../scripts/scrape-modem.js');
const { generateShowHtml, groupRuns, headingName } = require('./generate-html');
const { escapeHtml } = require('./lib');

// items: ordered, selected candidates (same shape /generate takes — each may
// carry .label and .headingSource now, see generate-html.js's headingName()).
// artists/labels: deduped names, in show order (the same lists the client's
// "Generate artist list" button builds — sent over so there's one source of
// truth for the dedup logic, not two implementations of it).
// showNumber: string/number, may be blank.
function buildSyntheticHtml(items, artists, labels, showNumber) {
  const bodyHtml = generateShowHtml(items);
  const links = (names) => names.map((a) => `<a href="#">${escapeHtml(a)}</a>`).join('\n');
  const title = showNumber ? `modem ///${showNumber}` : 'modem ///draft';
  return `<!doctype html>
<html><head>
<meta property="og:title" content="${escapeHtml(title)}">
</head><body>
<div class="field field--name-body field__item">
${bodyHtml}
</div>
<div class="field field--name-field-umetniki">
${links(artists)}
</div>
<div class="field field--name-field-zalozba">
${links(labels)}
</div>
</body></html>`;
}

// Cheap sanity checks the parse result makes obvious — not exhaustive, just
// the failure modes that are easy to hit when hand-building the tracklist.
//
// One real-site quirk this has to account for: a track's HEADING name always
// matches its own segment (it IS the heading text), but its non-heading name
// (e.g. the artist tag on a label-headed track) generally won't — the live
// site doesn't auto-attach that either; an admin fixes it after publishing
// via the /admin segment editor (see e.g. the modem-244 "PHO BHO" heading,
// whose artist tags needed a manual segEdit). So that's expected, not a bug —
// flagged as an FYI, not a warning, and only once as a single aggregate note.
//
// Grouped tracks (see generate-html.js's groupRuns()) share ONE heading/
// segment across several items, so `record.segments` has fewer entries than
// `items` once any group exists — itemToSeg maps each item to the segment
// index it actually landed in, and the heading-mismatch check runs once per
// group (at its first item) rather than once per track.
function buildWarnings(record, items) {
  const warnings = [];
  const notes = [];
  const runOf = groupRuns(items);
  const itemToSeg = [];
  {
    let seg = 0, i = 0;
    while (i < items.length) {
      if (runOf[i] === i) {
        let j = i;
        while (j + 1 < items.length && runOf[j + 1] === i) j++;
        for (let k = i; k <= j; k++) itemToSeg[k] = seg;
        seg++; i = j + 1;
      } else {
        itemToSeg[i] = seg; seg++; i++;
      }
    }
  }

  items.forEach((item, i) => {
    if (runOf[i] !== -1 && runOf[i] !== i) return; // grouped, but not the group's first — already checked
    const heading = (record.segments || [])[itemToSeg[i]];
    const headingKey = (heading || '').trim().toLowerCase();
    const expected = (runOf[i] === i ? (item.groupHeading || headingName(item)) : headingName(item)).trim().toLowerCase();
    const label = runOf[i] === i ? `Group starting at track ${i + 1} ("${item.title}")` : `Track ${i + 1} ("${item.title}")`;
    if (expected && headingKey !== expected) {
      warnings.push(`${label}: heading came out as "${heading}", expected "${expected}" — check for unusual characters in the name.`);
    }
    if (runOf[i] === -1) {
      const other = item.headingSource === 'label' ? item.artist : item.label;
      if (other && other.trim()) notes.push(i);
    }
  });
  if (notes.length) {
    warnings.push(`FYI: ${notes.length} track(s) have both an artist and a label — the non-heading one won't auto-link to its segment until you (or an admin) fix it after publishing, same as any label release on the live site.`);
  }

  const seen = new Map();
  (record.segments || []).forEach((label) => {
    const key = (label || '').trim().toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  });
  for (const [key, count] of seen) {
    if (count > 1 && key) warnings.push(`Heading "${key}" appears ${count}× — only the first will get an artist tag.`);
  }

  // A SoundCloud track the uploader restricted to self-embedding falls back
  // to a plain <a> link (see generate-html.js's buildSoundcloudEmbed) — the
  // live parser's extractEmbeds() only counts <iframe> tags, so that's one
  // fewer "embed" by design, not a failure. Don't count it toward expected.
  const expectedEmbeds = items.filter((it) => it.embeddable !== false).length;
  if (record.embeds.length !== expectedEmbeds) {
    warnings.push(`Expected ${expectedEmbeds} embed(s) but the parser found ${record.embeds.length} — an embed may have failed to generate correctly.`);
  }

  return warnings;
}

function previewDraft({ items, artists, labels, showNumber }) {
  const slug = showNumber ? `modem-${showNumber}` : 'modem-draft';
  const html = buildSyntheticHtml(items, artists || [], labels || [], showNumber);
  const record = parsePage(slug, html, 'show', null);
  const warnings = buildWarnings(record, items);
  return { record, warnings };
}

module.exports = { previewDraft };
