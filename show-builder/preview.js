// Preview a draft show exactly the way the live site's own scraper will see
// it, before anything is pasted into radioštudent. Builds a synthetic page
// with the same field wrapper divs scripts/scrape-modem.js's fieldByClass()
// looks for, then runs the REAL parsePage() against it — not a reimplementation.
const { parsePage } = require('../scripts/scrape-modem.js');
const { generateShowHtml } = require('./generate-html');
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
function buildWarnings(record, items) {
  const warnings = [];
  const notes = [];

  items.forEach((item, i) => {
    const heading = (record.segments || [])[i];
    const headingKey = (heading || '').trim().toLowerCase();
    const expected = (item.headingSource === 'label' && item.label ? item.label : item.artist || item.label || '').trim().toLowerCase();
    if (expected && headingKey !== expected) {
      warnings.push(`Track ${i + 1} ("${item.title}"): heading came out as "${heading}", expected "${expected}" — check for unusual characters in the name.`);
    }
    const other = item.headingSource === 'label' ? item.artist : item.label;
    if (other && other.trim()) notes.push(i);
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

  if (record.embeds.length !== items.length) {
    warnings.push(`Expected ${items.length} embed(s) but the parser found ${record.embeds.length} — an embed may have failed to generate correctly.`);
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
