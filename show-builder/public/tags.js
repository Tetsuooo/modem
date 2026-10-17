// "Tags" tab — find and merge doubled artist/label tags, and fix a release's
// own tags. The local, in-app version of src/admin.html's "tag merge" and
// "edit tags" tabs: same detection, same overrides.json format (documented in
// scripts/apply-overrides.js), so a merge made here and one made on the site's
// admin page are interchangeable.
//
// Saving writes src/assets/overrides.json only (show-builder/tag-tools.js); the
// next publish applies it to the site's data, re-deriving from source first when
// an edit was taken back, so merges are durable across re-scrapes and an
// un-merge reverts cleanly. Loaded after index.html's inline script and shares
// its globals (el, esc, escAttr).
(function () {
  'use strict';

  const normKey = (s) => (s == null ? '' : String(s)).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const DISMISS_KEY = 'sb-tag-dismissed';

  const T = {
    loaded: false, loading: false, sub: 'merge', saving: false, dirty: 0,
    tags: { artist: {}, label: {} },
    overrides: { tagMerges: {}, tagEdits: {}, segEdits: {} },
    selected: new Set(), canonPick: null,
    dismissed: new Set(), editQ: '', editTracks: [], editTimer: null,
  };
  try { T.dismissed = new Set(JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]')); } catch (e) { /* ignore */ }

  const dkey = (arr) => arr.slice().sort().join('||');
  function persistDismissed() { try { localStorage.setItem(DISMISS_KEY, JSON.stringify([...T.dismissed])); } catch (e) { /* ignore */ } }
  const host = () => el('tagsTab');

  async function load(quiet) {
    if (T.loading) return;
    T.loading = true;
    if (!quiet) host().innerHTML = '<div class="empty">loading tags…</div>';
    try {
      const r = await (await fetch('/tags/summary')).json();
      if (!r.ok) throw new Error(r.error);
      T.tags = { artist: r.artists, label: r.labels };
      // segEdits ride along untouched — they're written by the inline editor on
      // the site's show pages; dropping the field here would wipe them on save.
      T.overrides = { ...r.overrides, tagMerges: r.overrides.tagMerges || {}, tagEdits: r.overrides.tagEdits || {}, segEdits: r.overrides.segEdits || {} };
      T.loaded = true;
    } catch (e) {
      host().innerHTML = `<div class="errors">could not load tags: ${esc(e.message || e)}</div>`;
    }
    T.loading = false;
    if (T.loaded) render();
  }

  // ---------- detection ----------
  // names that normalise to the same string (case / spacing / invisible chars / accents)
  function clustersFor(kind) {
    const by = {};
    Object.keys(T.tags[kind]).forEach((n) => { const k = normKey(n); if (!k) return; (by[k] = by[k] || []).push(n); });
    return Object.values(by).filter((v) => v.length > 1)
      .filter((v) => new Set(v.map((n) => T.overrides.tagMerges[n] || n)).size > 1) // not already merged
      .filter((v) => !T.dismissed.has(dkey(v)))
      .sort((a, b) => b.reduce((s, n) => s + T.tags[kind][n], 0) - a.reduce((s, n) => s + T.tags[kind][n], 0));
  }
  // Levenshtein, bounded — anything past 2 edits counts as "far"
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
    for (let j = 1; j <= b.length; j++) {
      let prev = dp[0]; dp[0] = j;
      for (let i = 1; i <= a.length; i++) { const tmp = dp[i]; dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]); prev = tmp; }
    }
    return dp[a.length];
  }
  const SUFFIX = /^(records?|recordings?|rec|tapes?|editions?|music|ltd|label|sounds?|audio|productions?|prod|collective|netlabel|media|works?|inc|group)$/;
  const COLLAB = /\s&\s|\s\/\s|\bfeat\.?\b|\bft\.?\b|\sand\s|,|\s\+\s|\svs\.?\s|\sx\s/i; // "X & Y", "X feat Y" = a collab, NOT a dup
  // Looser "possible" candidates the exact pass misses: a suffix variant
  // ("x" vs "x records"), a containment, or a single-character typo.
  function fuzzyGroupsFor(kind) {
    const cnt = T.tags[kind];
    const norm = {};
    Object.keys(cnt).forEach((n) => { const k = normKey(n); if (k) (norm[k] = norm[k] || []).push(n); });
    const keys = Object.keys(norm).filter((k) => k.length >= 4);
    const disp = (k) => norm[k].slice().sort((a, b) => cnt[b] - cnt[a])[0];
    const out = [], seen = new Set();
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const a = keys[i], b = keys[j];
      const na = disp(a), nb = disp(b);
      const sh = a.length <= b.length ? a : b, lo = a.length <= b.length ? b : a;
      const longer = a.length <= b.length ? nb : na;
      let ok = false;
      if (lo.startsWith(sh) && lo.length - sh.length <= 12 && SUFFIX.test(lo.slice(sh.length))) ok = true;
      else if (sh.length >= 6 && lo.includes(sh) && !COLLAB.test(longer)) ok = true;
      else if (Math.min(a.length, b.length) >= 5 && lev(a, b) === 1) ok = true;
      if (!ok) continue;
      if ((T.overrides.tagMerges[na] || na) === (T.overrides.tagMerges[nb] || nb)) continue; // already merged together
      const key = kind + ':' + [na, nb].sort().join('||');
      if (seen.has(key) || T.dismissed.has([na, nb].sort().join('||'))) continue;
      seen.add(key);
      out.push([na, nb].sort((x, y) => cnt[y] - cnt[x]));
    }
    return out.sort((A, B) => (cnt[B[0]] + cnt[B[1]]) - (cnt[A[0]] + cnt[A[1]]));
  }

  // ---------- rendering ----------
  function shell() {
    host().innerHTML = `
      <div class="tg-sub">
        <button data-tg-sub="merge">Merge duplicates</button>
        <button data-tg-sub="edit">Edit a release’s tags</button>
        <span class="grow"></span>
        <span class="status" id="tgStat"></span>
        <button id="tgSave" class="accent" disabled>✔ save</button>
      </div>
      <div class="tg-savebar" id="tgSavebar"><b id="tgPending">0</b> unsaved change(s) <span class="grow"></span><span class="status">saved edits go onto the site with your next publish, and are re-applied on every rebuild after that.</span></div>
      <div id="tgMerge">
        <div class="tg-h">suggested merges — near-identical tags found automatically</div>
        <div class="tg-hint">Same name up to case / spacing / invisible characters / accents. Click a chip to choose which spelling to keep (green = kept), then merge.</div>
        <div id="tgSuggested"></div>
        <div class="tg-h">build a merge manually</div>
        <div class="tg-hint">Search and click tags that are the same artist/label, then pick the one to keep.</div>
        <input class="tg-input" id="tgTagSearch" type="search" placeholder="filter tags…" style="width:100%;margin-bottom:8px">
        <div class="tg-list" id="tgTagList"></div>
        <div class="tg-builder" id="tgBuilder"></div>
        <div class="tg-h">active merges (<span id="tgMCount">0</span>)</div>
        <div class="tg-merge-list" id="tgMergeList"></div>
      </div>
      <div id="tgEdit" hidden>
        <div class="tg-hint">Find a release, then add / remove / rename its artist &amp; label tags. Edits apply to search and the on-page chips, and survive re-scrapes.</div>
        <input class="tg-input" id="tgEditSearch" type="search" placeholder="find a release by title or artist…" style="width:100%;margin-bottom:10px">
        <div id="tgEditResults"><div class="empty">type to find a release…</div></div>
      </div>`;
    host().querySelectorAll('[data-tg-sub]').forEach((b) => { b.onclick = () => { T.sub = b.dataset.tgSub; render(); }; });
    el('tgSave').onclick = save;
    el('tgTagSearch').oninput = renderTagList;
    el('tgEditSearch').value = T.editQ;
    el('tgEditSearch').oninput = (e) => {
      T.editQ = e.target.value;
      clearTimeout(T.editTimer);
      T.editTimer = setTimeout(searchTracks, 250);
    };
  }

  function render() {
    if (!el('tgMerge')) shell();
    host().querySelectorAll('[data-tg-sub]').forEach((b) => b.classList.toggle('on', b.dataset.tgSub === T.sub));
    el('tgMerge').hidden = T.sub !== 'merge';
    el('tgEdit').hidden = T.sub !== 'edit';
    if (T.sub === 'merge') { renderSuggested(); renderTagList(); renderBuilder(); renderMerges(); }
    else renderEditResults();
    updateStat();
  }

  function updateStat() {
    const nA = Object.keys(T.tags.artist).length, nL = Object.keys(T.tags.label).length;
    el('tgStat').textContent = `${nA} artists · ${nL} labels · ${Object.keys(T.overrides.tagMerges).length} merges · ${Object.keys(T.overrides.tagEdits).length} edits`;
    el('tgMCount') && (el('tgMCount').textContent = Object.keys(T.overrides.tagMerges).length);
    el('tgPending').textContent = T.dirty;
    el('tgSavebar').classList.toggle('show', T.dirty > 0);
    if (!T.saving) { el('tgSave').disabled = T.dirty === 0; el('tgSave').textContent = '✔ save'; }
  }

  function clusterHtml(kind, variants, possible) {
    const canon = variants.slice().sort((a, b) => T.tags[kind][b] - T.tags[kind][a])[0]; // default = most used
    return `<div class="tg-cluster${possible ? ' possible' : ''}" data-kind="${kind}" data-canon="${escAttr(canon)}" data-pair="${escAttr(variants.join('||'))}">
      <div class="tg-row"><span class="tg-kind">${kind}</span>${possible ? '<span class="tg-maybe">possible</span>' : ''}
        <span class="variants">${variants.map((n) => `<span class="tg-variant${n === canon ? ' canon' : ''}" data-name="${escAttr(n)}">${esc(n)} <span class="cnt">${T.tags[kind][n]}</span></span>`).join('')}</span></div>
      <div class="tg-row" style="margin-top:8px"><span class="status">keep <b class="canon-name">${esc(canon)}</b></span>
        <button class="do-merge accent">merge ${variants.length} → 1</button>
        <button class="dismiss pill-btn">keep separate</button></div></div>`;
  }
  function renderSuggested() {
    const box = el('tgSuggested');
    let exact = '', fuzzy = '';
    ['artist', 'label'].forEach((kind) => clustersFor(kind).forEach((v) => { exact += clusterHtml(kind, v, false); }));
    ['artist', 'label'].forEach((kind) => fuzzyGroupsFor(kind).forEach((v) => { fuzzy += clusterHtml(kind, v, true); }));
    const dm = T.dismissed.size ? `<div class="tg-hint">${T.dismissed.size} pair(s) kept separate. <button id="tgResetDm" class="pill-btn">show them again</button></div>` : '';
    box.innerHTML = dm + (exact || (fuzzy ? '' : '<div class="tg-hint">no near-duplicate tags left 🎉</div>')) +
      (fuzzy ? '<div class="tg-fuzzy-head">possible matches — looser guesses (suffixes / typos / containment), check each carefully</div>' + fuzzy : '');
    const rd = el('tgResetDm'); if (rd) rd.onclick = () => { T.dismissed.clear(); persistDismissed(); render(); };
    box.querySelectorAll('.tg-cluster').forEach((c) => {
      c.querySelectorAll('.tg-variant').forEach((v) => {
        v.onclick = () => {
          c.querySelectorAll('.tg-variant').forEach((x) => x.classList.remove('canon'));
          v.classList.add('canon');
          c.dataset.canon = v.dataset.name;
          c.querySelector('.canon-name').textContent = v.dataset.name;
        };
      });
      c.querySelector('.do-merge').onclick = () => {
        const canon = c.dataset.canon;
        c.querySelectorAll('.tg-variant').forEach((v) => { if (v.dataset.name !== canon) addMerge(v.dataset.name, canon); });
        render();
      };
      c.querySelector('.dismiss').onclick = () => { T.dismissed.add(dkey(c.dataset.pair.split('||'))); persistDismissed(); render(); };
    });
  }

  function renderTagList() {
    const q = (el('tgTagSearch').value || '').toLowerCase();
    const all = [];
    ['artist', 'label'].forEach((kind) => Object.keys(T.tags[kind]).forEach((n) => all.push({ n, kind, c: T.tags[kind][n] })));
    all.sort((a, b) => b.c - a.c);
    const box = el('tgTagList');
    // A name already merged into another isn't offered again — the archive still
    // spells it the old way until the next publish applies the merge.
    box.innerHTML = all.filter((t) => !(t.n in T.overrides.tagMerges) && (!q || t.n.toLowerCase().includes(q))).slice(0, 400).map((t) =>
      `<span class="tg-variant${T.selected.has(t.n) ? ' sel' : ''}" data-name="${escAttr(t.n)}"><span class="tg-kind">${t.kind[0]}</span>${esc(t.n)} <span class="cnt">${t.c}</span></span>`
    ).join('') || '<span class="tg-hint">no tags match.</span>';
    box.querySelectorAll('.tg-variant').forEach((v) => {
      v.onclick = () => {
        const n = v.dataset.name;
        if (T.selected.has(n)) T.selected.delete(n); else T.selected.add(n);
        if (T.canonPick && !T.selected.has(T.canonPick)) T.canonPick = null;
        renderTagList(); renderBuilder();
      };
    });
  }

  function renderBuilder() {
    const box = el('tgBuilder');
    const arr = [...T.selected];
    if (arr.length < 2) {
      box.innerHTML = arr.length === 1 ? `<span class="tg-hint">pick at least one more tag to merge with “${esc(arr[0])}”.</span>` : '<span class="tg-hint">select tags above to build a merge.</span>';
      return;
    }
    if (!T.canonPick || !T.selected.has(T.canonPick)) T.canonPick = arr[0];
    box.innerHTML = `<div class="tg-row"><span class="tg-hint">merge:</span>
      ${arr.map((n) => `<span class="tg-variant${n === T.canonPick ? ' canon' : ''}" data-name="${escAttr(n)}">${esc(n)}</span>`).join('')}
      <span class="tg-hint">→ keep <b>${esc(T.canonPick)}</b></span>
      <button id="tgDoManual" class="accent">merge</button> <button id="tgClearSel" class="pill-btn">clear</button></div>`;
    box.querySelectorAll('.tg-variant').forEach((v) => { v.onclick = () => { T.canonPick = v.dataset.name; renderBuilder(); }; });
    el('tgDoManual').onclick = () => { arr.forEach((n) => { if (n !== T.canonPick) addMerge(n, T.canonPick); }); T.selected.clear(); T.canonPick = null; render(); };
    el('tgClearSel').onclick = () => { T.selected.clear(); T.canonPick = null; renderTagList(); renderBuilder(); };
  }

  function renderMerges() {
    const box = el('tgMergeList');
    const keys = Object.keys(T.overrides.tagMerges);
    if (!keys.length) { box.innerHTML = '<div class="tg-merge-row tg-hint">no merges yet.</div>'; return; }
    box.innerHTML = keys.map((from) =>
      `<div class="tg-merge-row"><span class="from">${esc(from)}</span><span>→</span><span class="to">${esc(T.overrides.tagMerges[from])}</span><span class="grow"></span><button class="pill-btn" data-from="${escAttr(from)}">undo</button></div>`
    ).join('');
    box.querySelectorAll('[data-from]').forEach((b) => { b.onclick = () => { delete T.overrides.tagMerges[b.dataset.from]; T.dirty++; render(); }; });
  }

  function addMerge(from, to) { if (from === to) return; T.overrides.tagMerges[from] = to; T.dirty++; }

  // ---------- edit a release's tags ----------
  // Same data model as src/admin.html, plus: edits already on record may carry
  // fields this editor doesn't show (`artists`, `title` — written by the site's
  // inline editor). Those are kept, and `artists` is updated along with
  // `artist` so the artist you type is the one that wins when it's applied.
  const edit = (key) => T.overrides.tagEdits[key];
  const curArtist = (t) => { const e = edit(t.key); if (e && Array.isArray(e.artists) && e.artists.length) return e.artists.join(' & '); return e && e.artist != null ? e.artist : (t.artist || ''); };
  const curLabels = (t) => { const e = edit(t.key); return e && Array.isArray(e.labels) ? e.labels.slice() : t.labels.slice(); };
  const labChip = (n) => `<span class="tg-lab" data-name="${escAttr(n)}">${esc(n)} <button class="rm" title="remove">×</button></span>`;

  function editCardHtml(t) {
    const edited = !!edit(t.key);
    const shows = t.shows.map((s) => (s.type === 'list' ? String(s.slug).replace(/-0$/, '').replace(/-/g, ' ') : 'modem ' + s.number)).join(', ');
    return `<div class="tg-card${edited ? ' edited' : ''}" data-key="${escAttr(t.key)}">
      <div class="tg-card-head">${t.artUrl ? `<img src="${escAttr(t.artUrl)}" loading="lazy" alt="">` : '<span class="tg-thumb"></span>'}
        <div><div class="tg-card-title">${esc(t.title || '(untitled)')}</div><div class="tg-card-sub">${esc(shows)}${edited ? ' · <b>edited</b>' : ''}</div></div></div>
      <div class="tg-field"><label>artist</label><input class="tg-input tg-artist" value="${escAttr(curArtist(t))}"></div>
      <div class="tg-field"><label>labels</label><span class="tg-labs">${curLabels(t).map(labChip).join('')}</span>
        <input class="tg-input tg-addlab" placeholder="+ add label, Enter"></div>
      <div class="tg-field">${edited ? '<button class="tg-reset pill-btn">reset to original</button>' : ''}</div></div>`;
  }

  function commitCard(card) {
    const key = card.dataset.key, t = T.editTracks.find((x) => x.key === key);
    if (!t) return;
    const artist = card.querySelector('.tg-artist').value.trim();
    const labels = [...card.querySelectorAll('.tg-lab')].map((x) => x.dataset.name);
    const prev = edit(key);
    const unchanged = artist === (t.artist || '') && labels.join('|') === t.labels.join('|');
    if (!prev && unchanged) return; // nothing to record
    const next = { ...(prev || {}), artist, labels };
    if (prev && Array.isArray(prev.artists) && prev.artists.length && artist !== prev.artists.join(' & ')) {
      next.artists = artist.split(' & ').map((n) => n.trim()).filter(Boolean);
    }
    T.overrides.tagEdits[key] = next;
    T.dirty++; updateStat();
    card.outerHTML = editCardHtml(t);
    wireCards();
  }
  function wireCards() {
    el('tgEditResults').querySelectorAll('.tg-card').forEach((card) => {
      card.querySelectorAll('.rm').forEach((b) => { b.onclick = () => { b.closest('.tg-lab').remove(); commitCard(card); }; });
      card.querySelector('.tg-artist').onchange = () => commitCard(card);
      const add = card.querySelector('.tg-addlab');
      add.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = add.value.trim();
        if (v) { card.querySelector('.tg-labs').insertAdjacentHTML('beforeend', labChip(v)); add.value = ''; commitCard(card); }
      };
      const reset = card.querySelector('.tg-reset');
      if (reset) {
        reset.onclick = () => {
          const key = card.dataset.key;
          delete T.overrides.tagEdits[key];
          T.dirty++; updateStat();
          card.outerHTML = editCardHtml(T.editTracks.find((x) => x.key === key));
          wireCards();
        };
      }
    });
  }
  async function searchTracks() {
    const q = T.editQ.trim();
    if (!q) { T.editTracks = []; renderEditResults(); return; }
    try {
      const r = await (await fetch('/tags/tracks?q=' + encodeURIComponent(q))).json();
      if (q !== T.editQ.trim()) return; // a newer search is already on its way
      T.editTracks = r.ok ? r.tracks : [];
    } catch (e) { T.editTracks = []; }
    renderEditResults();
  }
  function renderEditResults() {
    const box = el('tgEditResults');
    const q = T.editQ.trim();
    if (!q) { box.innerHTML = '<div class="empty">type to find a release…</div>'; return; }
    box.innerHTML = T.editTracks.length ? T.editTracks.map(editCardHtml).join('') : `<div class="empty">no release matches “${esc(q)}”.</div>`;
    wireCards();
  }

  // ---------- save ----------
  async function save() {
    if (!T.dirty || T.saving) return;
    T.saving = true;
    const btn = el('tgSave'); btn.disabled = true; btn.textContent = 'saving…';
    let r;
    try {
      r = await (await fetch('/tags/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides: T.overrides }) })).json();
    } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    if (!r.ok) { btn.textContent = '✗ ' + (r.error || 'error'); T.saving = false; setTimeout(updateStat, 3000); return; }
    T.dirty = 0; T.saving = false;
    await load(true);
    if (T.sub === 'edit') searchTracks();
    btn.textContent = '✔ saved — goes onto the site with your next publish';
    setTimeout(updateStat, 4000);
  }

  window.addEventListener('beforeunload', (e) => { if (T.dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.tagsTabActivated = function () { if (!T.loaded) load(); };
  if (!el('panel-tags').hidden) window.tagsTabActivated(); // restored tab (switchTab ran before this file loaded)
})();
