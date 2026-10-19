// "Edit site" tab (was "Tags") — edit how the site tags a show, find and merge
// doubled artist/label tags, fix a release's own tags, and publish those edits.
//   • Edit a show: every heading of one show with the chips the site gives it
//     (show-builder/site-tools.js) — add / rename / remove / flip artist↔label
//     → overrides.json "segEdits"; each track's own credits → "tagEdits". The
//     same two things the pencils on the site's show pages write when the local
//     website preview runs (src/archive.html), without having to run it.
//   • Merge duplicates / Edit a release: the local version of src/admin.html's
//     "tag merge" and "edit tags" tabs — same detection, same overrides.json
//     format (documented in scripts/apply-overrides.js).
//
// Saving writes src/assets/overrides.json only (show-builder/tag-tools.js).
// "Publish site edits" (server.js /publish-edits-run → /publish-push) rebuilds
// the site with the saved edits — re-deriving from source first when an edit was
// taken back — shows what changes, offers a local preview, and pushes only on
// request; a show publish takes saved edits along too. Loaded after
// index.html's inline script and shares its globals (el, esc, escAttr).
(function () {
  'use strict';

  const normKey = (s) => (s == null ? '' : String(s)).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  const DISMISS_KEY = 'sb-tag-dismissed';

  const T = {
    loaded: false, loading: false, sub: 'show', saving: false, dirty: 0,
    unsaved: new Set(), // "slug::seg" / track keys changed since the last save (badges in Edit a show)
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
        <button data-tg-sub="show">Edit a show</button>
        <button data-tg-sub="merge">Merge duplicates</button>
        <button data-tg-sub="edit">Edit a release’s tags</button>
        <span class="grow"></span>
        <span class="status" id="tgStat"></span>
        <button id="tgSave" class="accent" disabled>✔ save</button>
      </div>
      <div class="tg-savebar" id="tgSavebar"><b id="tgPending">0</b> unsaved change(s) <span class="grow"></span><span class="status">save, then <b>Publish site edits</b> below puts them on the site (a show publish takes them along too).</span></div>
      <div class="se-pub" id="sePub">
        <div class="tg-row"><span id="sePubInfo" class="status">checking what isn’t on the site yet…</span><span class="grow"></span>
          <button id="sePubRun" class="accent" disabled>Publish site edits</button></div>
        <div id="sePubBox" hidden><pre class="log se-log" id="sePubLog"></pre><div id="sePubReview"></div></div>
      </div>
      <div id="tgShow">
        <div class="tg-row se-pick">
          <button id="sePrev" class="pill-btn" title="older show">◀</button>
          <input class="tg-input" id="seSearch" list="seRecList" placeholder="show number (e.g. 249) or list name…" autocomplete="off">
          <datalist id="seRecList"></datalist>
          <button id="seNext" class="pill-btn" title="newer show">▶</button>
          <span class="grow"></span>
          <a id="seLive" class="pill-btn" target="_blank" rel="noopener" hidden>open on the site ↗</a>
        </div>
        <div id="seBody"><div class="empty">loading shows…</div></div>
      </div>
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
    el('sePubRun').onclick = runPublishEdits;
    el('sePrev').onclick = () => stepShow(+1);
    el('seNext').onclick = () => stepShow(-1);
    el('seSearch').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); pickFromSearch(); } };
    el('seSearch').onchange = pickFromSearch;
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
    el('tgShow').hidden = T.sub !== 'show';
    el('tgMerge').hidden = T.sub !== 'merge';
    el('tgEdit').hidden = T.sub !== 'edit';
    if (T.sub === 'show') showView();
    else if (T.sub === 'merge') { renderSuggested(); renderTagList(); renderBuilder(); renderMerges(); }
    else renderEditResults();
    updateStat();
  }

  function updateStat() {
    const nA = Object.keys(T.tags.artist).length, nL = Object.keys(T.tags.label).length;
    const nSeg = Object.values(T.overrides.segEdits).reduce((s, m) => s + Object.keys(m || {}).length, 0);
    el('tgStat').textContent = `${nA} artists · ${nL} labels · ${Object.keys(T.overrides.tagMerges).length} merges · ${Object.keys(T.overrides.tagEdits).length} release edits · ${nSeg} heading edits`;
    el('tgMCount') && (el('tgMCount').textContent = Object.keys(T.overrides.tagMerges).length);
    el('tgPending').textContent = T.dirty;
    el('tgSavebar').classList.toggle('show', T.dirty > 0);
    if (!T.saving) { el('tgSave').disabled = T.dirty === 0; el('tgSave').textContent = '✔ save'; }
    updatePubButton();
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
        <div><div class="tg-card-title">${esc(t.title || '(untitled)')}</div><div class="tg-card-sub">${[esc(shows), edited ? '<b>edited</b>' : ''].filter(Boolean).join(' · ')}</div></div></div>
      <div class="tg-field"><label>artist</label><input class="tg-input tg-artist" value="${escAttr(curArtist(t))}"></div>
      <div class="tg-field"><label>labels</label><span class="tg-labs">${curLabels(t).map(labChip).join('')}</span>
        <input class="tg-input tg-addlab" placeholder="+ add label, Enter"></div>
      <div class="tg-field">${edited ? '<button class="tg-reset pill-btn">reset to original</button>' : ''}</div></div>`;
  }

  // box/list/onChange: the "Edit a release" search results by default; Edit a
  // show passes its own track list and re-renders the show on a change.
  function commitCard(card, box, list, onChange) {
    const key = card.dataset.key, t = list.find((x) => x.key === key);
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
    T.unsaved.add(key);
    T.dirty++; updateStat();
    if (onChange) return onChange();
    card.outerHTML = editCardHtml(t);
    wireCards(box, list, onChange);
  }
  function wireCards(box = el('tgEditResults'), list = T.editTracks, onChange = null) {
    box.querySelectorAll('.tg-card').forEach((card) => {
      const commit = () => commitCard(card, box, list, onChange);
      card.querySelectorAll('.rm').forEach((b) => { b.onclick = () => { b.closest('.tg-lab').remove(); commit(); }; });
      card.querySelector('.tg-artist').onchange = commit;
      const add = card.querySelector('.tg-addlab');
      add.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const v = add.value.trim();
        if (v) { card.querySelector('.tg-labs').insertAdjacentHTML('beforeend', labChip(v)); add.value = ''; commit(); }
      };
      const reset = card.querySelector('.tg-reset');
      if (reset) {
        reset.onclick = () => {
          const key = card.dataset.key;
          delete T.overrides.tagEdits[key];
          T.unsaved.add(key);
          T.dirty++; updateStat();
          if (onChange) return onChange();
          card.outerHTML = editCardHtml(list.find((x) => x.key === key));
          wireCards(box, list, onChange);
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

  // ---------- edit a show ----------
  // One show (or year-end list) the way its page shows it: each heading with
  // its artist + label chips, and the tracks under it. A heading's chips are
  // replaced as a whole by an edit (segEdits[slug][seg] = { artists, labels }),
  // exactly like the site's own pencil — so start from what's shown and change it.
  const SHOW_KEY = 'sb-site-show';
  const S = { records: null, slug: null, data: null, loading: false, editTrack: null, pending: new Set(), pendingTracks: new Set() };
  const recName = (r) => (r.type === 'show' && r.number ? `modem ///${r.number}` : r.title) + (r.date ? ` · ${r.date}` : '');

  async function showView() {
    if (!S.records) {
      try {
        const r = await (await fetch('/site/records')).json();
        if (!r.ok) throw new Error(r.error);
        S.records = r.records;
      } catch (e) { el('seBody').innerHTML = `<div class="errors">could not load the shows: ${esc(e.message || e)}</div>`; return; }
      el('seRecList').innerHTML = S.records.map((r) => `<option value="${escAttr(recName(r))}">`).join('');
      let last = null;
      try { last = localStorage.getItem(SHOW_KEY); } catch (e) { /* ignore */ }
      openShow(S.records.some((r) => r.slug === last) ? last : (S.records[0] || {}).slug);
      return;
    }
    renderShow();
  }

  function pickFromSearch() {
    const q = el('seSearch').value.trim();
    if (!q || !S.records) return;
    const num = (q.match(/^(?:modem\s*\/*\s*)?(\d+)\b/i) || [])[1];
    const hit = S.records.find((r) => recName(r) === q) ||
      (num && S.records.find((r) => r.type === 'show' && String(r.number) === String(Number(num)))) ||
      S.records.find((r) => recName(r).toLowerCase().includes(q.toLowerCase()) || r.slug === q);
    // Leave the field, so its suggestion list closes — otherwise the next click
    // on the page only closes the list instead of pressing what was clicked.
    if (hit) { el('seSearch').blur(); openShow(hit.slug); }
    else el('seBody').innerHTML = `<div class="empty">no show or list matches “${esc(q)}”.</div>`;
  }
  // +1 = older, -1 = newer (records are newest show first, then the lists)
  function stepShow(dir) {
    if (!S.records || !S.slug) return;
    const i = S.records.findIndex((r) => r.slug === S.slug);
    const next = S.records[i + dir];
    if (next) openShow(next.slug);
  }

  async function openShow(slug) {
    if (!slug) return;
    S.slug = slug; S.editTrack = null; S.loading = true;
    try { localStorage.setItem(SHOW_KEY, slug); } catch (e) { /* ignore */ }
    const r0 = (S.records || []).find((r) => r.slug === slug);
    el('seSearch').value = r0 ? recName(r0) : slug;
    el('seBody').innerHTML = '<div class="empty">loading…</div>';
    try {
      const r = await (await fetch('/site/record?slug=' + encodeURIComponent(slug))).json();
      if (!r.ok) throw new Error(r.error);
      if (S.slug !== slug) return; // another show was picked meanwhile
      r.headings.forEach((h) => h.tracks.forEach((t) => { t.shows = []; }));
      r.looseTracks.forEach((t) => { t.shows = []; });
      S.data = r;
    } catch (e) {
      el('seBody').innerHTML = `<div class="errors">could not load ${esc(slug)}: ${esc(e.message || e)}</div>`;
      S.loading = false;
      return;
    }
    S.loading = false;
    renderShow();
  }

  const segEditOf = (seg) => (T.overrides.segEdits[S.slug] || {})[seg];
  // What a heading will show once the saved/unsaved edits are published.
  function chipsOf(h) {
    const e = segEditOf(h.seg);
    if (e) return { artists: (e.artists || []).slice(), labels: (e.labels || []).slice(), state: 'edited' };
    // edited on the site, edit removed here → the original tags come back on publish
    if (h.edited) return { artists: h.artists.slice(), labels: h.labels.slice(), state: 'reset' };
    return { artists: h.artists.slice(), labels: h.labels.slice(), state: '' };
  }
  const allTracks = () => (S.data ? [...S.data.headings.flatMap((h) => h.tracks), ...S.data.looseTracks] : []);

  function chipHtml(kind, n) {
    return `<span class="se-chip ${kind}" data-kind="${kind}" data-name="${escAttr(n)}"><span class="se-name" title="click to rename">${esc(n)}</span>` +
      `<button class="se-mv" title="make it ${kind === 'artist' ? 'a label' : 'an artist'}">⇄</button><button class="se-rm" title="remove">×</button></span>`;
  }
  function trackHtml(t) {
    const e = edit(t.key);
    const artist = curArtist(t), labels = curLabels(t);
    const open = S.editTrack === t.key;
    return `<div class="se-track${e ? ' edited' : ''}" data-key="${escAttr(t.key)}">
        ${t.artUrl ? `<img src="${escAttr(t.artUrl)}" loading="lazy" alt="">` : '<span class="tg-thumb"></span>'}
        <span class="se-ttitle">${esc(t.title || '(untitled)')}</span>
        <span class="se-tcred">${esc(artist || '—')}${labels.length ? ' · ' + esc(labels.join(', ')) : ''}</span>
        ${T.unsaved.has(t.key) ? '<span class="se-badge unsaved">unsaved</span>' : S.pendingTracks.has(t.key) ? '<span class="se-badge pending">not on the site yet</span>' : e ? '<span class="se-badge">edited</span>' : ''}
        <span class="grow"></span>
        ${t.link ? `<a class="pill-btn" href="${escAttr(t.link)}" target="_blank" rel="noopener" title="open the track">↗</a>` : ''}
        <button class="pill-btn se-tedit${open ? ' on' : ''}">${open ? 'close' : 'credits'}</button>
      </div>${open ? `<div class="se-tcard">${editCardHtml(t)}</div>` : ''}`;
  }
  function headingHtml(h, i) {
    const c = chipsOf(h);
    const id = S.slug + '::' + h.seg;
    const badge = T.unsaved.has(id) ? '<span class="se-badge unsaved">unsaved</span>'
      : S.pending.has(id) ? '<span class="se-badge pending">not on the site yet</span>'
      : c.state === 'edited' ? '<span class="se-badge">edited</span>' : '';
    const row = (kind, names) => `<div class="tg-field se-field"><label>${kind}s</label><span class="se-chips">${names.map((n) => chipHtml(kind, n)).join('')}</span>
        <input class="tg-input se-add" data-kind="${kind}" data-list="${kind === 'artist' ? 'artistNamesList' : 'labelNamesList'}" placeholder="+ ${kind}, Enter"></div>`;
    return `<div class="se-head ${c.state}" data-seg="${h.seg}">
      <div class="tg-row se-top"><span class="se-n">${i + 1}</span>
        <span class="se-text" title="the heading as written on radioštudent">${esc(h.text || '(no heading text)')} <span class="se-slashes">///////</span></span>
        ${badge}<span class="grow"></span>
        ${c.state === 'edited' ? '<button class="pill-btn se-reset" title="drop this edit — the heading goes back to the tags it was scraped with">reset to original</button>' : ''}</div>
      ${c.state === 'reset' ? '<div class="tg-hint">edit removed — this heading goes back to its original tags when you publish.</div>' : ''}
      ${h.handsOnTo != null ? '<div class="tg-hint">empty heading (nothing under it) — on the site its tags show on the next heading.</div>' : ''}
      ${row('artist', c.artists)}${row('label', c.labels)}
      <div class="se-tracks">${h.tracks.length ? h.tracks.map(trackHtml).join('') : '<div class="tg-hint">no track found under this heading (a dead embed or a plain link).</div>'}</div>
    </div>`;
  }

  function renderShow() {
    const box = el('seBody');
    const r = S.records && S.records.findIndex((x) => x.slug === S.slug);
    el('sePrev').disabled = !S.records || r < 0 || r >= S.records.length - 1;
    el('seNext').disabled = !S.records || r <= 0;
    if (!S.data || S.data.record.slug !== S.slug) { if (!S.loading) box.innerHTML = '<div class="empty">pick a show.</div>'; return; }
    const rec = S.data.record;
    el('seLive').hidden = false;
    el('seLive').href = rec.liveUrl;
    const u = S.data.untied;
    const untied = (u.artists.length || u.labels.length)
      ? `<div class="se-untied"><span class="tg-hint">also tagged on this show, not under any heading (only in the “all tags” line at the bottom of the page):</span>
          ${u.artists.map((n) => `<span class="se-chip artist ro">${esc(n)}</span>`).join('')}${u.labels.map((n) => `<span class="se-chip label ro">${esc(n)}</span>`).join('')}</div>`
      : '';
    const scrollY = window.scrollY;
    box.innerHTML = `
      <div class="se-rec">${rec.cover ? `<img src="${escAttr(rec.cover)}" alt="">` : ''}<div>
        <div class="tg-card-title">${esc(rec.title)}</div>
        <div class="tg-card-sub">${esc(rec.date || '')}${rec.source ? ` · <a href="${escAttr(rec.source)}" target="_blank" rel="noopener">radioštudent page</a>` : ''}${rec.origin === 'show-builder' ? ' · built in the show builder' : ''}</div></div></div>
      <div class="tg-hint">Each heading shows these tags on the site. Click a name to rename it, <b>⇄</b> to switch it between artist and label, <b>×</b> to remove it, or type a new one. <b>credits</b> on a track fixes that track’s own artist/labels (what search and the player use).</div>
      ${S.data.headings.map(headingHtml).join('') || '<div class="tg-hint">this page has no headings — fix each track’s own credits below.</div>'}
      ${S.data.looseTracks.length ? `<div class="se-head se-loose"><div class="tg-row se-top"><span class="se-text">${S.data.headings.length ? 'tracks not under a heading' : 'tracks'}</span></div>
        <div class="se-tracks">${S.data.looseTracks.map(trackHtml).join('')}</div></div>` : ''}
      ${untied}`;
    window.scrollTo(0, scrollY);
    wireShow(box);
  }

  function setSeg(seg, artists, labels) {
    const m = (T.overrides.segEdits[S.slug] = T.overrides.segEdits[S.slug] || {});
    m[seg] = { artists, labels };
    T.unsaved.add(S.slug + '::' + seg);
    T.dirty++;
    updateStat();
    renderShow();
  }
  const hasName = (arr, n) => arr.some((x) => x.toLowerCase() === n.toLowerCase());

  function wireShow(box) {
    const loose = box.querySelector('.se-loose');
    if (loose) {
      loose.querySelectorAll('.se-track').forEach((row) => {
        row.querySelector('.se-tedit').onclick = () => { S.editTrack = S.editTrack === row.dataset.key ? null : row.dataset.key; renderShow(); };
      });
      const card = loose.querySelector('.se-tcard');
      if (card) wireCards(card, allTracks(), renderShow);
    }
    box.querySelectorAll('.se-head:not(.se-loose)').forEach((head) => {
      const seg = Number(head.dataset.seg);
      const h = S.data.headings.find((x) => x.seg === seg);
      const cur = () => chipsOf(h);
      head.querySelectorAll('.se-chip').forEach((chip) => {
        const kind = chip.dataset.kind, name = chip.dataset.name;
        const listOf = (c, k) => (k === 'artist' ? c.artists : c.labels);
        chip.querySelector('.se-rm').onclick = () => {
          const c = cur(); const arr = listOf(c, kind); arr.splice(arr.indexOf(name), 1);
          setSeg(seg, c.artists, c.labels);
        };
        chip.querySelector('.se-mv').onclick = () => {
          const c = cur(); const from = listOf(c, kind), to = listOf(c, kind === 'artist' ? 'label' : 'artist');
          from.splice(from.indexOf(name), 1);
          if (!hasName(to, name)) to.push(name);
          setSeg(seg, c.artists, c.labels);
        };
        chip.querySelector('.se-name').onclick = () => {
          const input = document.createElement('input');
          input.className = 'tg-input se-rename';
          input.value = name;
          input.dataset.list = kind === 'artist' ? 'artistNamesList' : 'labelNamesList';
          deferList(input);
          chip.replaceWith(input);
          input.focus(); input.select();
          let done = false;
          const commit = () => {
            if (done) return; done = true;
            const v = input.value.trim();
            if (v === name) return renderShow();
            const c = cur(); const arr = listOf(c, kind); const i = arr.indexOf(name);
            if (!v) arr.splice(i, 1); else if (hasName(arr.filter((x) => x !== name), v)) arr.splice(i, 1); else arr[i] = v;
            setSeg(seg, c.artists, c.labels);
          };
          input.onkeydown = (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); done = true; renderShow(); }
          };
          input.onblur = commit;
        };
      });
      head.querySelectorAll('.se-add').forEach((input) => {
        deferList(input);
        input.onkeydown = (e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          const v = input.value.trim();
          if (!v) return;
          const kind = input.dataset.kind;
          const c = cur(); const arr = kind === 'artist' ? c.artists : c.labels;
          if (hasName(arr, v)) { input.value = ''; return; }
          arr.push(v);
          setSeg(seg, c.artists, c.labels);
          const again = el('seBody').querySelector(`.se-head[data-seg="${seg}"] .se-add[data-kind="${kind}"]`);
          if (again) again.focus(); // ready for the next name
        };
      });
      const reset = head.querySelector('.se-reset');
      if (reset) reset.onclick = () => {
        const m = T.overrides.segEdits[S.slug];
        if (m) { delete m[seg]; if (!Object.keys(m).length) delete T.overrides.segEdits[S.slug]; }
        T.unsaved.add(S.slug + '::' + seg);
        T.dirty++;
        updateStat();
        renderShow();
      };
      head.querySelectorAll('.se-track').forEach((row) => {
        row.querySelector('.se-tedit').onclick = () => { S.editTrack = S.editTrack === row.dataset.key ? null : row.dataset.key; renderShow(); };
      });
      const card = head.querySelector('.se-tcard');
      if (card) wireCards(card, allTracks(), renderShow);
    });
  }
  // Same trick as the site's editor: attach the ~2,500-name suggestion list only
  // once something is typed, so focusing the field doesn't pop the whole list.
  function deferList(input) {
    input.addEventListener('input', () => {
      if (input.value.trim()) input.setAttribute('list', input.dataset.list);
      else input.removeAttribute('list');
    });
  }

  // ---------- publish site edits ----------
  const P = { pending: null, polling: null, job: null };

  async function refreshPending() {
    try {
      const r = await (await fetch('/site/pending')).json();
      if (!r.ok) throw new Error(r.error);
      P.pending = r;
      S.pending = new Set(r.segEdits);
      S.pendingTracks = new Set(r.tagEdits);
    } catch (e) { P.pending = null; }
    updatePubButton();
    if (T.sub === 'show' && S.data) renderShow();
  }

  function updatePubButton() {
    const btn = el('sePubRun'), info = el('sePubInfo');
    if (!btn) return;
    const p = P.pending;
    const busy = P.job && (P.job.running || (P.job.done && P.job.kind === 'edits'));
    if (!p) { info.textContent = ''; btn.disabled = true; return; }
    const bits = [];
    if (p.segEdits.length) bits.push(`${p.segEdits.length} heading${p.segEdits.length > 1 ? 's' : ''}`);
    if (p.tagEdits.length) bits.push(`${p.tagEdits.length} release${p.tagEdits.length > 1 ? 's' : ''}`);
    if (p.tagMerges) bits.push(`${p.tagMerges} merge${p.tagMerges > 1 ? 's' : ''}`);
    if (p.scLinks) bits.push(`${p.scLinks} SoundCloud link${p.scLinks > 1 ? 's' : ''}`);
    info.innerHTML = p.total
      ? `<b>Saved, not on the site yet:</b> ${esc(bits.join(' · '))}`
      : 'Everything saved is on the site.';
    if (T.dirty) info.innerHTML += ' <span class="se-warn">— save your changes first.</span>';
    btn.disabled = !p.total || T.dirty > 0 || !!busy;
  }

  async function runPublishEdits() {
    el('sePubRun').disabled = true;
    el('sePubBox').hidden = false;
    el('sePubReview').innerHTML = '';
    el('sePubLog').textContent = 'starting…';
    let r;
    try { r = await (await fetch('/publish-edits-run', { method: 'POST' })).json(); } catch (e) { r = { ok: false, error: 'could not reach the show builder: ' + (e.message || e) }; }
    if (!r.ok) {
      el('sePubLog').textContent = '';
      el('sePubReview').innerHTML = `<div class="errors">${esc(r.error || 'could not start')}${r.dirtyFiles ? '<br>' + r.dirtyFiles.map(esc).join('<br>') : ''}</div>`;
      updatePubButton();
      return;
    }
    pollPublish();
  }

  function pollPublish() {
    clearInterval(P.polling);
    const tick = async () => {
      let j;
      try { j = await (await fetch('/publish-status')).json(); } catch (e) { return; }
      P.job = j;
      if (j.kind !== 'edits') { clearInterval(P.polling); updatePubButton(); return; } // a show publish — that's the Publish & Edit tab's
      if (!el('sePubBox')) return; // tab still loading — next tick
      el('sePubBox').hidden = false;
      el('sePubLog').textContent = (j.log || []).join('\n');
      el('sePubLog').scrollTop = el('sePubLog').scrollHeight; // newest line in view
      if (j.running) return;
      clearInterval(P.polling);
      renderReview(j);
      updatePubButton();
    };
    P.polling = setInterval(tick, 1500);
    tick();
  }

  function renderReview(j) {
    const box = el('sePubReview');
    if (j.error) { box.innerHTML = `<div class="errors">the rebuild failed: ${esc(j.error)} — nothing was changed on the site. The log above says where.</div>`; return; }
    const ch = j.changed;
    const list = ch && ch.records.length
      ? `<ul class="se-changes">${ch.records.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`
      : '<div class="tg-hint">no show or list changes (only track details, if anything).</div>';
    box.innerHTML = `<div class="se-review">
      <div><b>Rebuilt on this computer.</b> Publishing would change:</div>${list}
      ${ch && ch.trackCredits ? `<div class="tg-hint">${ch.trackCredits} track${ch.trackCredits > 1 ? 's’' : '’s'} own credits change with it (what search and the player show).</div>` : ''}
      ${ch && ch.trackDetails ? `<div class="tg-hint">${ch.trackDetails} other track detail${ch.trackDetails > 1 ? 's get' : ' gets'} brought up to date too (search text, SoundCloud playback info) — a side effect of rebuilding, not of your edits.</div>` : ''}
      <div class="tg-row">
        <button id="sePreview" class="pill-btn">preview on this computer ↗</button>
        <button id="sePush" class="accent">Push to the live site</button>
        <button id="seDiscard" class="pill-btn">discard this build</button>
        <span class="status" id="sePushStat">nothing is live until you push.</span></div></div>`;
    el('sePreview').onclick = openPreview;
    el('sePush').onclick = pushEdits;
    el('seDiscard').onclick = discardBuild;
  }

  async function openPreview() {
    const w = window.open('', '_blank'); // open now (inside the click) so it isn't blocked
    try {
      const r = await (await fetch('/site/preview', { method: 'POST' })).json();
      if (!r.ok) throw new Error(r.error);
      const path = S.slug ? '/' + encodeURIComponent(S.slug) : '/';
      if (w) w.location = r.base + path; else window.open(r.base + path, '_blank');
    } catch (e) {
      if (w) w.close();
      el('sePushStat').textContent = 'preview failed: ' + (e.message || e);
    }
  }

  async function pushEdits() {
    const btn = el('sePush');
    btn.disabled = true; btn.textContent = 'pushing…';
    let r;
    try { r = await (await fetch('/publish-push', { method: 'POST' })).json(); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    if (!r.ok) { btn.disabled = false; btn.textContent = 'Push to the live site'; el('sePushStat').textContent = '✗ ' + (r.error || 'push failed'); return; }
    P.job = null;
    el('sePubLog').textContent = '';
    el('sePubReview').innerHTML = `<div class="se-review">✔ ${r.pushed ? 'Pushed. The live site updates in a minute or two' : 'Nothing to commit'}${S.data ? ` — <a href="${escAttr(S.data.record.liveUrl)}" target="_blank" rel="noopener">${esc(S.data.record.title)} on the site ↗</a>` : ''}.</div>`;
    await refreshPending();
    if (S.slug) openShow(S.slug); // the archive changed
  }

  async function discardBuild() {
    let r;
    try { r = await (await fetch('/publish-discard', { method: 'POST' })).json(); } catch (e) { r = { ok: false, error: String(e.message || e) }; }
    if (!r.ok) { el('sePushStat').textContent = '✗ ' + (r.error || 'could not discard'); return; }
    P.job = null;
    el('sePubBox').hidden = true;
    await refreshPending();
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
    T.dirty = 0; T.saving = false; T.unsaved.clear();
    await load(true);
    if (T.sub === 'edit') searchTracks();
    // A finished "Publish site edits" build doesn't contain what was just saved.
    if (P.job && P.job.done && P.job.kind === 'edits') {
      el('sePubReview').innerHTML = '<div class="errors">You saved more edits after this build, so they aren’t in it — press <b>Publish site edits</b> again.</div>';
      P.job = null;
    }
    await refreshPending();
    btn.textContent = '✔ saved — Publish site edits puts it on the site';
    setTimeout(updateStat, 4000);
  }

  window.addEventListener('beforeunload', (e) => { if (T.dirty) { e.preventDefault(); e.returnValue = ''; } });
  window.tagsTabActivated = function () {
    if (!T.loaded) load();
    refreshPending();
    pollPublish(); // picks a finished-but-unpushed (or running) site-edits build back up after a reload
  };
  if (!el('panel-tags').hidden) window.tagsTabActivated(); // restored tab (switchTab ran before this file loaded)
})();
