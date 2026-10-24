// "Does the show on radioštudent still match my draft?" — now that the site is
// built from the draft rather than from the radioštudent page, a hand-edit made
// ONLY on radioštudent (a track dropped, two swapped, a heading retyped) would
// leave the two out of step without anyone noticing. This fetches the live page,
// runs it through the same parser as the draft, and lists what differs.
//
// Compared: the tracklist headings (names + order) and the embeds. Nothing is
// changed anywhere; it only reports.
const { parsePage } = require('../scripts/scrape-modem.js');
const { generateShowHtml } = require('./generate-html');
const { curlGet } = require('./lib');

// `edited`: the HTML edited by hand in the Publish tab — what was pasted, so what to compare
function parseDraft(slug, number, items, edited) {
  const html = edited || generateShowHtml(items);
  const page = `<!doctype html><html><head><meta property="og:title" content="modem ///${number}"></head><body>` +
    `<div class="field field--name-body field__item">\n${html}\n</div></body></html>`;
  return parsePage(slug, page, 'show', null);
}

// Which embeds does a record play, in order? (src with the transparent=/size
// parameters etc. left in — both sides come from the same generator.)
const embedKeys = (rec) => (rec.embeds || []).map((e) => e.src);

// Human-readable differences between two ordered string lists.
function listDiff(label, draftList, liveList) {
  const out = [];
  const onlyDraft = draftList.filter((x) => !liveList.includes(x));
  const onlyLive = liveList.filter((x) => !draftList.includes(x));
  onlyDraft.forEach((x) => out.push(`${label} only in your draft: ${x}`));
  onlyLive.forEach((x) => out.push(`${label} only on radioštudent: ${x}`));
  if (!onlyDraft.length && !onlyLive.length && draftList.join('\n') !== liveList.join('\n')) {
    out.push(`${label} are the same but in a different order`);
  }
  return out;
}

function compareWithLive(show, items, edited) {
  const slug = `modem-${show}`;
  let html;
  try {
    html = curlGet(`https://radiostudent.si/glasba/modem/${slug}`);
  } catch (e) {
    return { live: false, error: String(e.message || e) };
  }
  const notFound =
    /<title>\s*Stran ni bila najdena/i.test(html) ||
    /<link rel="canonical" href="https:\/\/radiostudent\.si\/"\s*\/?>/i.test(html) ||
    html.length < 500;
  if (notFound) return { live: false };

  const live = parsePage(slug, html, 'show', null);
  const draft = parseDraft(slug, show, items, edited);
  const differences = [
    ...listDiff('headings', draft.segments || [], live.segments || []),
    ...listDiff('embeds', embedKeys(draft), embedKeys(live)),
  ];
  return { live: true, same: differences.length === 0, differences, headings: (live.segments || []).length };
}

module.exports = { compareWithLive };
