/*
 * overrides-diff.js — does a new version of src/assets/overrides.json TAKE BACK
 * something the previous one had applied (a merge removed or pointed at a
 * different name, an edit reset, a segment edit dropped)?
 *
 * That's the one case where applying the overrides on top of the archive isn't
 * enough: the archive no longer holds the original spelling, so it has to be
 * re-derived from source (scrape-modem.js --reparse, bracketed by
 * reparse-guard.js). Everything else — new merges, new or changed edits — is
 * just apply-overrides.js on the archive as it is.
 *
 * Used by every place that saves or publishes tag edits: the show builder's
 * publish pipeline (show-builder/server.js), its Tags tab (show-builder/
 * tag-tools.js), and the main dev server's /save-overrides (server.js).
 */
function undoesSomething(prev, next) {
  prev = prev || {};
  next = next || {};
  const gone = (a, b, same) =>
    Object.keys(a || {}).some((k) => !(k in (b || {})) || (same && JSON.stringify(a[k]) !== JSON.stringify(b[k])));
  return gone(prev.tagMerges, next.tagMerges, true) || gone(prev.tagEdits, next.tagEdits, false) || gone(prev.segEdits, next.segEdits, false);
}

module.exports = { undoesSomething };
