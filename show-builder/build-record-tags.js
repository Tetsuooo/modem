// Builds a show record's artists/labels tag lists straight from the
// show-builder draft's own per-track artist/label fields — the same data
// public/index.html's injectSegTagsPreview() renders as chips in the Preview
// tab, and the same per-segment grouping generateShowHtml() uses to build the
// tracklist HTML that gets pasted into radioštudent. Used by
// scripts/apply-draft-tags.js so a publish can trust the Arrange tab's own
// tags instead of whatever radiostudent.si's separate "umetniki"/"založba"
// taxonomy fields happen to have (or not have) filled in — see the modem-248
// incident: the show's tracklist body was live and correct, but nobody had
// gone into RS's own admin fields to tag artists/labels there, so
// scrape-modem.js's field-umetniki/field-zalozba scrape correctly found
// nothing to attach.
const { groupRuns, headingName } = require('./generate-html');

// Deliberately NOT split on commas: a track's artist/label field is treated
// as ONE atomic tag string, matching both injectSegTagsPreview() (what the
// user actually verified in the Preview tab — it never splits either) and
// real radiostudent.si precedent (its own taxonomy tags include names with
// literal commas in them, e.g. modem-209's "1rokit, yves aoi, jian" as a
// SINGLE tag, modem-230's "estuary..fragmentation:.,. ...", modem-243's
// ", s!p!d!"). Splitting here would wrongly shred a stylized name that
// happens to contain a comma (confirmed against a real modem-248 track,
// "﴾◣.,,.◢﴿, tgwog, supersheep", which splitting mangled into 4 garbage
// fragments) — safer to under-split (one combined tag for a genuine
// multi-artist credit) than to corrupt a name that isn't actually a list.
//
// items: the draft's ordered `selected` array (same shape generateShowHtml()
// takes). Returns { artists, labels }, each a list of {name, url, seg} — the
// same shape scrape-modem.js's parsePage() produces for a record's own
// .artists/.labels, so it can be dropped straight in. url is always null:
// these are plain typed names, not radiostudent.si entity-page references.
//
// seg assignment matches generateShowHtml()'s own block order exactly (one
// seg per heading, grouped runs sharing one), so segment N here lines up
// with segment N in the scraped page's data-seg markers — as long as nobody
// hand-edits the tracklist on radiostudent.si after pasting it.
function buildRecordTags(items) {
  const runOf = groupRuns(items);
  const artists = [];
  const labels = [];
  let seg = 0;
  let i = 0;
  while (i < items.length) {
    if (runOf[i] === i) {
      let j = i;
      while (j + 1 < items.length && runOf[j + 1] === i) j++;
      const group = items.slice(i, j + 1);
      // Same convention as injectSegTagsPreview(): every distinct real
      // artist in the run gets its own tag, then the shared heading gets a
      // label tag too — unless it's already one of those artists (a
      // single-artist multi-track release like "Cold Storage", vs. a
      // various-artists compilation like "mappa").
      const seen = new Set();
      group.forEach((it) => {
        const nm = (it.artist || '').trim();
        const key = nm.toLowerCase();
        if (!nm || seen.has(key)) return;
        seen.add(key);
        artists.push({ name: nm, url: null, seg });
      });
      const heading = (group[0].groupHeading || headingName(group[0])).trim();
      if (heading && !seen.has(heading.toLowerCase())) {
        labels.push({ name: heading, url: null, seg });
      }
      i = j + 1;
    } else {
      const it = items[i];
      const artist = (it.artist || '').trim();
      const label = (it.label || '').trim();
      if (artist) artists.push({ name: artist, url: null, seg });
      if (label) labels.push({ name: label, url: null, seg });
      i++;
    }
    seg++;
  }
  return { artists, labels };
}

module.exports = { buildRecordTags };
