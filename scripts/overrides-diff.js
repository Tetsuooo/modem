/*
 * overrides-diff.js — does a new version of src/assets/overrides.json TAKE BACK
 * something the previous one had applied (a merge removed or pointed at a
 * different name, an edit reset, a segment edit dropped, moved tracks moved again or
 * put back)?
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
  // segEdits is two levels deep (show → heading): resetting ONE heading of a show
  // that keeps other edited headings is a take-back too — apply-overrides.js only
  // rewrites the headings still listed, so the reset one would keep its edit.
  const segGone = Object.keys(prev.segEdits || {}).some((slug) => gone(prev.segEdits[slug], (next.segEdits || {})[slug], false));
  // orderEdits (show → heading, moved tracks): moving a heading's tracks again or putting
  // them back needs the original order, and once a move is applied the archive only holds
  // the new one — so a changed order counts too, not just a removed one (track-order.js)
  const orderGone = Object.keys(prev.orderEdits || {}).some((slug) => gone(prev.orderEdits[slug], (next.orderEdits || {})[slug], true));
  return gone(prev.tagMerges, next.tagMerges, true) || gone(prev.tagEdits, next.tagEdits, false) || segGone || orderGone;
}

module.exports = { undoesSomething };
