#!/usr/bin/env node
/*
 * gen-review.js — turn scripts/sc-match-candidates.json into a self-contained
 * review page (scripts/sc-match-review.html) for manually approving Bandcamp→
 * SoundCloud matches.
 *
 * The page embeds its data, so just open it in a browser (double-click / file://
 * is fine — the players are https iframes). For each Bandcamp track it plays the
 * Bandcamp original and the candidate SoundCloud uploads side by side; you pick
 * the right one (or "none"). Progress is saved to localStorage; hit "export" to
 * download approvals.json, then run apply-sc-matches.js.
 *
 * Usage: node scripts/gen-review.js
 */

const fs = require('fs');
const path = require('path');

const CAND = path.join(__dirname, 'sc-match-candidates.json');
const APPROVALS = path.join(__dirname, 'approvals.json');
const OUT = path.join(__dirname, 'sc-match-review.html');

const all = JSON.parse(fs.readFileSync(CAND, 'utf8'));
// Embed the committed approvals so the page ALWAYS seeds from them — otherwise a
// stale tab (loaded before a file-side change like auto-confirm-matches.js) would
// POST an incomplete set to /save-approvals and clobber those decisions.
const fileApprovals = fs.existsSync(APPROVALS) ? JSON.parse(fs.readFileSync(APPROVALS, 'utf8')) : {};
// Show every Bandcamp track so a match can be picked OR pasted in manually.
// Order: review (real decisions) → auto (pre-approved) → weak/none (mostly for
// pasting a link you found yourself).
const rankOf = (o) => (o.tier === 'review' ? 0 : o.tier === 'auto' ? 1 : (o.candidates.length ? 2 : 3));
const data = all.slice().sort((a, b) => rankOf(a) - rankOf(b));

const counts = {
  total: all.length,
  auto: all.filter((o) => o.tier === 'auto').length,
  review: all.filter((o) => o.tier === 'review').length,
  none: all.filter((o) => o.tier === 'none').length,
};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>modem · bandcamp → soundcloud match review</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Arial, sans-serif; background: #f4f4f4; color: #000; }
  header { position: sticky; top: 0; z-index: 5; background: #000; color: #fff; padding: 0.6rem 1rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
  header b { font-size: 1rem; }
  header .stat { font-size: 0.85rem; opacity: 0.85; }
  header .grow { flex: 1; }
  button { font-family: Arial, sans-serif; font-weight: bold; cursor: pointer; border: 2px solid #000; background: #fff; padding: 0.4rem 0.8rem; border-radius: 4px; }
  button:hover { background: #ffff00; }
  header button { border-color: #fff; background: #222; color: #fff; }
  header button:hover { background: #ffff00; color: #000; border-color: #ffff00; }
  header input#q { min-width: 220px; font-family: Arial, sans-serif; font-size: 0.85rem; font-weight: bold; padding: 0.4rem 0.6rem; border: 2px solid #fff; border-radius: 4px; background: #fff; color: #000; }
  header input#q::placeholder { font-weight: normal; opacity: 0.6; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 1rem; }
  .bc { background: #fff; border: 2px solid #000; padding: 0.8rem; display: flex; gap: 0.9rem; align-items: flex-start; }
  .bc img { width: 96px; height: 96px; object-fit: cover; background: #eee; flex: none; }
  .bc .meta { flex: 1; min-width: 0; }
  .tag { font-size: 0.62rem; font-weight: bold; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.55; }
  .ttl { font-size: 1.1rem; font-weight: bold; word-break: break-word; }
  .sub { font-size: 0.9rem; opacity: 0.7; word-break: break-word; }
  .dur { font-size: 0.8rem; opacity: 0.6; }
  .bc iframe { width: 100%; height: 120px; border: 0; margin-top: 0.5rem; }
  .bc a { font-size: 0.75rem; color: #0645ad; }
  h3 { margin: 1.1rem 0 0.4rem; font-size: 0.85rem; text-transform: lowercase; letter-spacing: 0.03em; opacity: 0.6; }
  .cand { background: #fff; border: 2px solid #000; padding: 0.6rem 0.7rem; margin-bottom: 0.6rem; }
  .cand.picked { outline: 4px solid #16a34a; }
  .cand .row { display: flex; align-items: center; gap: 0.7rem; }
  .cthumb { width: 60px; height: 60px; object-fit: cover; background: #eee; flex: none; display: block; }
  .cand .row .meta { flex: 1; min-width: 0; }
  .cand .durbad { color: #b91c1c; }
  .snip { color: #b91c1c; font-weight: bold; }
  .canon { color: #16a34a; font-weight: bold; }
  .cand .durok { color: #16a34a; }
  .cand iframe { width: 100%; height: 120px; border: 0; margin-top: 0.5rem; }
  .manual { display: flex; gap: 0.5rem; margin: 0.6rem 0 0; }
  .manual input { flex: 1; font-family: Arial, sans-serif; font-size: 0.85rem; padding: 0.45rem 0.6rem; border: 2px solid #000; border-radius: 4px; }
  .manual.picked input { outline: 4px solid #2563eb; }
  .actions { display: flex; gap: 0.6rem; align-items: center; margin: 1rem 0 2rem; }
  .none { border-color: #b91c1c; }
  .none.picked { outline: 4px solid #b91c1c; background: #fee; }
  .donemsg { text-align: center; padding: 3rem 1rem; font-weight: bold; opacity: 0.7; }
  kbd { background: #000; color: #fff; border-radius: 3px; padding: 0 0.35rem; font-size: 0.75rem; }
  .hint { font-size: 0.78rem; opacity: 0.6; }
</style></head><body>
<header>
  <b>bandcamp → soundcloud</b>
  <input id="q" type="search" placeholder="find a release to link… (artist / title / modem N)">
  <span class="stat" id="pos"></span>
  <span class="stat" id="tally"></span>
  <span class="grow"></span>
  <span class="hint">keys: <kbd>1-5</kbd> pick · <kbd>0</kbd>/<kbd>n</kbd> none · <kbd>←</kbd><kbd>→</kbd> nav</span>
  <button id="findmatches" title="search SoundCloud for Bandcamp tracks not yet in this queue (e.g. newly-scraped shows)">⟲ find new matches</button>
  <button id="modebtn">backlog</button>
  <button id="nomatchbtn" title="every Bandcamp track that has no SoundCloud link yet">⌀ no match</button>
  <button id="prev">‹ prev</button>
  <button id="next">next ›</button>
  <button id="saveapply">✔ save &amp; apply to site</button>
  <button id="export">export (backup)</button>
</header>
<div class="wrap" id="card"></div>
<script>
  const DATA = ${JSON.stringify(data)};
  const COUNTS = ${JSON.stringify(counts)};
  const KEY = 'modem-sc-approvals-v1';
  const FILE_APPROVALS = ${JSON.stringify(fileApprovals)};
  // Start from the committed approvals.json, then let THIS browser's localStorage
  // edits win on top. Guarantees file-side decisions (auto-confirms) are never lost
  // when the page saves back.
  const approvals = Object.assign({}, FILE_APPROVALS, JSON.parse(localStorage.getItem(KEY) || '{}'));
  // pre-approve the airtight "auto" tier (user can still override)
  DATA.forEach((o) => { if (o.tier === 'auto' && !(o.key in approvals)) approvals[o.key] = o.suggest; });
  let mode = 'todo', idx = 0, query = ''; // 'todo' = undecided queue, 'done' = decided backlog

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmt = (s) => s ? Math.floor(s/60)+':'+String(s%60).padStart(2,'0') : '–';
  const scPlayer = (id) => 'https://w.soundcloud.com/player/?url=' + encodeURIComponent('https://api.soundcloud.com/tracks/'+id) + '&visual=false&hide_related=true&show_comments=false&auto_play=false';
  function save() { localStorage.setItem(KEY, JSON.stringify(approvals)); }

  const undecided = () => DATA.filter((o) => !(o.key in approvals));
  // A search hits every release (decided or not) so you can jump straight to one
  // you want to (re)link — e.g. an album that was never matched. Empty search →
  // the normal review todo-queue / decided backlog.
  function searchMatch(o, terms) {
    const hay = ((o.bcArtist || '') + ' ' + (o.bcTitle || '') + ' modem ' + (o.shows || []).join(' modem ')).toLowerCase();
    return terms.every((t) => hay.indexOf(t) !== -1);
  }
  const unmatched = () => DATA.filter((o) => !approvals[o.key]); // no SC link: undecided OR decided-none
  function list() {
    const q = query.trim().toLowerCase();
    if (q) return DATA.filter((o) => searchMatch(o, q.split(/\s+/)));
    if (mode === 'nomatch') return unmatched();
    return mode === 'todo' ? undecided() : DATA.filter((o) => o.key in approvals);
  }
  // deciding drops a track out of the review queue (into the backlog); undo returns it
  function pick(o, val) { approvals[o.key] = val; save(); render(); }
  function undo(o) { delete approvals[o.key]; save(); render(); }

  function render() {
    const L = list();
    if (idx >= L.length) idx = Math.max(0, L.length - 1);
    const todoN = undecided().length, doneN = DATA.length - todoN;
    const matched = DATA.filter((o) => approvals[o.key]).length;
    document.getElementById('tally').textContent = todoN + ' to review · ' + doneN + ' decided · ' + matched + ' matched';
    const nomatchN = unmatched().length;
    document.getElementById('modebtn').textContent = mode === 'done' ? ('‹ to review (' + todoN + ')') : ('backlog (' + doneN + ') ›');
    const nmb = document.getElementById('nomatchbtn');
    nmb.textContent = mode === 'nomatch' ? ('‹ to review (' + todoN + ')') : ('⌀ no match (' + nomatchN + ')');
    nmb.style.borderColor = mode === 'nomatch' ? '#ffff00' : '';
    const searching = !!query.trim();
    document.getElementById('pos').textContent = !L.length ? ''
      : searching ? ('found ' + L.length + ' · ' + (idx+1) + ' of ' + L.length)
      : mode === 'nomatch' ? ('no match · ' + (idx+1) + ' of ' + L.length)
      : mode === 'todo' ? ('reviewing · ' + (idx+1) + ' of ' + L.length + ' left')
      : ('backlog · ' + (idx+1) + ' of ' + L.length);
    if (!L.length) {
      document.getElementById('card').innerHTML = '<div class="donemsg">' +
        (searching ? 'no release matches “' + esc(query.trim()) + '”.'
          : mode === 'nomatch' ? '✔ every track has a soundcloud match!'
          : mode === 'todo' ? '✔ nothing left to review!<br>click <b>save &amp; apply to site</b>, or open the <b>backlog</b> to double-check.'
          : 'the backlog is empty.') + '</div>';
      return;
    }
    const o = L[idx];
    const cur = approvals[o.key];
    const cands = o.candidates.map((c, i) => {
      const dd = (o.bcDuration && c.duration) ? Math.abs(o.bcDuration - c.duration) : null;
      const durCls = dd == null ? '' : (dd <= 4 ? 'durok' : 'durbad');
      const durTxt = dd == null ? '' : (' · Δ' + dd + 's');
      const art = c.artwork ? c.artwork.replace(/-large\.(jpg|png)/i, '-t120x120.$1') : '';
      return '<div class="cand' + (cur === c.id ? ' picked' : '') + '">' +
        '<div class="row">' + (art ? '<img class="cthumb" src="' + esc(art) + '" alt="">' : '<span class="cthumb"></span>') +
        '<div class="meta"><div class="tag">soundcloud · candidate ' + (i+1) + (c.canonical ? ' · <span class="canon">✓ artist/label’s own upload</span>' : '') + '</div>' +
        '<div class="ttl">' + esc(c.title) + '</div><div class="sub">' + esc(c.user) + '</div>' +
        '<div class="dur ' + durCls + '">' + fmt(c.duration) + durTxt + (c.snip ? ' · <span class="snip">⚠ 30s preview only</span>' : '') + ' · <a href="' + esc(c.permalink) + '" target="_blank">open ↗</a></div></div>' +
        '<button data-pick="' + c.id + '">✓ use this (' + (i+1) + ')</button></div>' +
        '<iframe loading="lazy" src="' + esc(scPlayer(c.id)) + '"></iframe></div>';
    }).join('');
    const isManual = typeof cur === 'string';
    const savedLabel = cur === undefined ? 'not decided yet'
      : cur === null ? 'saved: none (keeps bandcamp)'
      : isManual ? 'saved: manual link'
      : 'saved: candidate #' + (o.candidates.findIndex((c) => c.id === cur) + 1);
    document.getElementById('card').innerHTML =
      '<div class="bc">' +
        (o.bcArt ? '<img src="' + esc(o.bcArt) + '" alt="">' : '<div class="bc-noimg"></div>') +
        '<div class="meta"><div class="tag">bandcamp · original</div>' +
        '<div class="ttl">' + esc(o.bcTitle) + '</div><div class="sub">' + esc(o.bcArtist) + '</div>' +
        '<div class="dur">' + fmt(o.bcDuration) + (o.bcLabel && o.bcLabel.toLowerCase() !== (o.bcArtist || '').toLowerCase() ? ' · on <b>' + esc(o.bcLabel) + '</b>' : '') + ' · featured in modem ' + o.shows.join(', ') + ' · <a href="' + esc(o.bcLink) + '" target="_blank">open ↗</a></div>' +
        (o.bcEmbed ? '<iframe loading="lazy" src="' + esc(o.bcEmbed) + '"></iframe>' : '') +
        '</div></div>' +
      (o.candidates.length ? '<h3>soundcloud candidates — pick the matching one</h3>' + cands
        : '<h3>no auto-found candidates — paste a link below if you have one</h3>') +
      '<div class="manual' + (isManual ? ' picked' : '') + '"><input type="text" id="man" placeholder="paste a soundcloud track url or id you found yourself…" value="' + (isManual ? esc(cur) : '') + '"><button id="manset">use this link</button></div>' +
      '<div class="actions"><button class="none' + (cur === null ? ' picked' : '') + '" data-none="1">✗ none — keep bandcamp (0 / n)</button>' +
        (mode === 'done' ? '<button id="undo">↩ undo (re-review)</button>' : '') +
        '<span class="hint">' + savedLabel + '</span></div>';

    document.querySelectorAll('[data-pick]').forEach((b) => b.onclick = () => pick(o, Number(b.getAttribute('data-pick'))));
    document.querySelector('[data-none]').onclick = () => pick(o, null);
    const man = document.getElementById('man');
    const setMan = () => { const v = man.value.trim(); if (v) pick(o, v); };
    document.getElementById('manset').onclick = setMan;
    man.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); setMan(); } };
    const ub = document.getElementById('undo'); if (ub) ub.onclick = () => undo(o);
    window.scrollTo(0, 0);
  }

  document.getElementById('findmatches').onclick = async () => {
    const btn = document.getElementById('findmatches');
    if (location.protocol === 'file:') { alert('Open this at http://localhost:8085/match-review to run the finder.'); return; }
    if (!confirm('Search SoundCloud for every Bandcamp track not yet in this queue (e.g. from newly-added shows)?\\n\\nThis can take many minutes — you can keep reviewing while it runs. The page reloads with the new candidates when it finishes.')) return;
    btn.disabled = true; btn.textContent = '⟲ starting…';
    try { await fetch('/run-find-matches', { method: 'POST' }); }
    catch (e) { btn.textContent = '✗ no dev server'; btn.disabled = false; return; }
    const poll = setInterval(async () => {
      let j; try { j = await (await fetch('/find-matches-status')).json(); } catch (e) { return; }
      if (j.running) { btn.textContent = '⟲ ' + String(j.progress || 'searching…').replace(/^\\s*…\\s*/, '').slice(0, 46); }
      else {
        clearInterval(poll);
        if (j.done) { btn.textContent = '✔ done — reloading…'; setTimeout(() => location.reload(), 1400); }
        else { btn.textContent = '✗ ' + (j.error || 'error'); btn.disabled = false; }
      }
    }, 2500);
  };
  document.getElementById('q').oninput = (e) => { query = e.target.value; idx = 0; render(); };
  document.getElementById('modebtn').onclick = () => { mode = (mode === 'done' ? 'todo' : 'done'); idx = 0; render(); };
  document.getElementById('nomatchbtn').onclick = () => { mode = (mode === 'nomatch' ? 'todo' : 'nomatch'); idx = 0; render(); };
  document.getElementById('prev').onclick = () => { const L = list(); if (L.length) { idx = (idx - 1 + L.length) % L.length; render(); } };
  document.getElementById('next').onclick = () => { const L = list(); if (L.length) { idx = (idx + 1) % L.length; render(); } };
  document.getElementById('export').onclick = () => {
    const blob = new Blob([JSON.stringify(approvals, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'approvals.json'; a.click();
  };
  // one-click: POST approvals to the dev server, which saves them + runs apply-sc-matches
  document.getElementById('saveapply').onclick = async () => {
    const btn = document.getElementById('saveapply');
    if (location.protocol === 'file:') { alert('Open this page at http://localhost:8085/match-review to use save & apply.'); return; }
    const orig = btn.textContent; btn.disabled = true; btn.textContent = 'saving…';
    try {
      const r = await fetch('/save-approvals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(approvals) });
      const j = await r.json();
      if (j.ok) { btn.textContent = '✔ applied! reload the site'; }
      else { btn.textContent = '✗ error'; alert('apply failed:\\n' + j.error); }
    } catch (e) { btn.textContent = '✗ error'; alert('could not reach the dev server:\\n' + e); }
    setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 3500);
  };
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const L = list(); if (!L.length) return;
    const o = L[idx];
    if (e.key === 'ArrowRight') { idx = (idx+1)%L.length; render(); }
    else if (e.key === 'ArrowLeft') { idx = (idx-1+L.length)%L.length; render(); }
    else if (e.key === 'n' || e.key === '0') pick(o, null);
    else if (/^[1-5]$/.test(e.key)) { const c = o.candidates[Number(e.key)-1]; if (c) pick(o, c.id); }
  });
  if (!DATA.length) document.getElementById('card').innerHTML = '<div class="donemsg">no candidates to review 🎉</div>';
  else render();
</script></body></html>`;

fs.writeFileSync(OUT, html);
console.log('Wrote review page → ' + path.relative(path.resolve(__dirname, '..'), OUT));
console.log('  reviewable tracks: ' + data.length + ' (' + counts.review + ' review + ' + counts.auto + ' auto pre-approved)');
console.log('  open it in a browser, approve matches, then "export approvals" → run apply-sc-matches.js');
