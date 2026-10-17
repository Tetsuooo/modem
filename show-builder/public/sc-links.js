// Bandcamp → SoundCloud linking, client side. A Bandcamp track that has a
// SoundCloud upload linked streams from SoundCloud on the live site (credit and
// link stay Bandcamp) — see scripts/apply-sc-matches.js and show-builder/sc-links.js.
//
//   1. Arrange tab: a "SoundCloud" row under every Bandcamp track in "Your show"
//      (find / pick / paste / "none"), plus a bulk "Find links" button. The pick is
//      stored on the draft item as `scPlay` (SoundCloud track id or URL, or null =
//      "no SoundCloud version") and carried into approvals.json when the show is
//      published (scripts/apply-draft-sc.js).
//   2. "SoundCloud links" tab: the backlog — every Bandcamp track from past shows,
//      with its ranked candidates, to review / link / search for.
//
// Loaded after index.html's inline script and shares its globals (selected,
// esc, escAttr, el, saveDraft, ...).
(function () {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const fmt = (s) => (s ? Math.floor(s / 60) + ':' + String(Math.round(s) % 60).padStart(2, '0') : '–');
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    try { return await r.json(); } catch (e) { return { ok: false, error: 'server returned ' + r.status }; }
  }
  const isBandcamp = (it) => it.source === 'bandcamp-wishlist' || it.source === 'bandcamp-library';
  // A link is either a SoundCloud track id (number) or a pasted URL (string).
  const widgetSrc = (v) =>
    'https://w.soundcloud.com/player/?url=' +
    encodeURIComponent(/^https?:/i.test(String(v)) ? String(v) : 'https://api.soundcloud.com/tracks/' + v) +
    '&visual=false&hide_related=true&show_comments=false&auto_play=false';
  function parseManual(raw) {
    const v = String(raw || '').trim();
    if (!v) return { error: 'paste a SoundCloud track URL or id first' };
    if (/^\d+$/.test(v)) return { val: Number(v) };
    if (/^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i.test(v)) return { val: v };
    return { error: 'that doesn’t look like a soundcloud.com link or a track id' };
  }
  const metaOf = (c) => ({ title: c.title, user: c.user, permalink: c.permalink, artwork: c.artwork, duration: c.duration });

  // ---------- candidate card (shared by the Arrange picker and the tab) ----------
  // frames: true = the SoundCloud player is already in the card (review tab, where
  // you compare by ear); false = loaded on demand via "▶ preview" (Arrange, where
  // a dozen cards would otherwise load a dozen players).
  function candHtml(c, i, bcDur, pickedId, frames) {
    const dd = bcDur && c.duration ? Math.abs(bcDur - c.duration) : null;
    const art = c.artwork ? c.artwork.replace(/-large\.(jpg|png)/i, '-t120x120.$1') : '';
    return `<div class="sc-cand${pickedId != null && String(pickedId) === String(c.id) ? ' picked' : ''}">
      <div class="sc-cand-main">
        ${art ? `<img src="${escAttr(art)}" loading="lazy" alt="">` : '<span class="sc-thumb"></span>'}
        <div class="meta">
          <div class="ttl">${esc(c.title)}</div>
          <div class="sub">${esc(c.user)}${c.canonical ? ' · <span class="canon">✓ artist/label’s own upload</span>' : ''}</div>
          <div class="dur">${fmt(c.duration)}${dd != null ? ` · <span class="${dd <= 4 ? 'good' : 'bad'}">Δ${dd}s</span>` : ''} · <a href="${escAttr(c.permalink)}" target="_blank" rel="noopener">open ↗</a></div>
        </div>
        <div class="sc-cand-btns">
          ${frames ? '' : `<button data-sc-prev="${escAttr(c.id)}">▶ preview</button>`}
          <button class="accent" data-sc-pick="${escAttr(c.id)}">✓ use this${i < 5 ? ' (' + (i + 1) + ')' : ''}</button>
        </div>
      </div>
      <div class="sc-frame" data-frame="${escAttr(c.id)}"${frames ? '' : ' hidden'}>${frames ? `<iframe loading="lazy" src="${escAttr(widgetSrc(c.id))}"></iframe>` : ''}</div>
    </div>`;
  }
  // Show/hide a candidate's SoundCloud player (the "▶ preview" button).
  function togglePreview(btn) {
    const fr = btn.closest('.sc-cand').querySelector('.sc-frame');
    if (fr.hidden) { fr.innerHTML = `<iframe src="${escAttr(widgetSrc(btn.dataset.scPrev))}"></iframe>`; fr.hidden = false; btn.textContent = '■ close'; }
    else { fr.innerHTML = ''; fr.hidden = true; btn.textContent = '▶ preview'; }
  }
  // root: any element holding candidate cards; onPick(candidate) fires on "use this".
  function wireCands(root, cands, onPick) {
    root.querySelectorAll('[data-sc-pick]').forEach((b) => {
      b.onclick = () => { const c = cands.find((x) => String(x.id) === b.dataset.scPick); if (c) onPick(c); };
    });
    root.querySelectorAll('[data-sc-prev]').forEach((b) => { b.onclick = () => togglePreview(b); });
  }

  // =====================================================================
  // 1. Arrange: per-track SoundCloud row
  // =====================================================================
  // Panel/search state is UI-only, so it lives here, not on the draft item
  // (which gets saved, synced and snapshotted for undo).
  const panels = new Map(); // item key -> { open, loading, error, result, extra, q, note }
  const panelOf = (key) => { if (!panels.has(key)) panels.set(key, {}); return panels.get(key); };
  const itemByKey = (key) => selected.find((s) => s.key === key);

  function linkLabel(it) {
    const m = it.scMeta;
    if (m && m.title) return `${esc(m.title)}${m.user ? ' — ' + esc(m.user) : ''}${m.duration ? ' · ' + fmt(m.duration) : ''}`;
    return typeof it.scPlay === 'string' ? esc(it.scPlay.replace(/^https?:\/\/(www\.)?/, '')) : 'SoundCloud track ' + esc(it.scPlay);
  }
  function permalinkOf(it) {
    if (it.scMeta && it.scMeta.permalink) return it.scMeta.permalink;
    return typeof it.scPlay === 'string' ? it.scPlay : null;
  }

  function panelHtml(it, st) {
    const cands = (st.result && st.result.candidates) || [];
    const bcDur = it.duration || null;
    let body;
    if (st.loading) body = '<div class="sc-note">searching SoundCloud…</div>';
    else if (st.error) body = `<div class="sc-note err">${esc(st.error)}</div>`;
    else {
      body = cands.length
        ? cands.map((c, i) => candHtml(c, i, bcDur, it.scPlay, false)).join('')
        : '<div class="sc-note">no candidates found automatically — try a search below, or paste a link.</div>';
      if (st.extra && st.extra.length) {
        body += '<div class="sc-note" style="margin:8px 0 4px">search results</div>' + st.extra.map((c, i) => candHtml(c, 9, bcDur, it.scPlay, false)).join('');
      }
    }
    const defQ = st.q != null ? st.q : [it.artist, it.title].filter(Boolean).join(' ');
    return `<div class="sc-panel">
      <div class="sc-panel-head"><span>SoundCloud candidates</span><span class="grow"></span>
        <button class="pill-btn" data-sc="none" title="no SoundCloud version — keep streaming from Bandcamp">✗ none — keep Bandcamp</button>
        <button class="pill-btn" data-sc="close">close</button></div>
      ${body}
      <div class="sc-manual"><input class="sc-input" data-sc-input="search" placeholder="search SoundCloud…" value="${escAttr(defQ)}"><button data-sc="search">search</button></div>
      <div class="sc-manual"><input class="sc-input" data-sc-input="manual" placeholder="or paste a SoundCloud track URL / id you found yourself…"><button data-sc="manual">use this link</button></div>
      ${st.note ? `<div class="sc-note err" style="margin-top:4px">${esc(st.note)}</div>` : ''}
    </div>`;
  }

  function rowInner(it) {
    const st = panelOf(it.key);
    const R = st.result;
    let line;
    if (st.loading && !st.open) {
      line = '<span class="sc-label">SoundCloud</span><span class="sc-note">searching…</span>';
    } else if (it.scPlay === undefined) {
      const hint = R
        ? (R.candidates.length ? `<span class="sc-badge todo">${R.candidates.length} candidate${R.candidates.length === 1 ? '' : 's'} — review</span>` : '<span class="sc-badge none">nothing found</span>')
        : '<span class="sc-badge todo">not linked</span>';
      line = `<span class="sc-label">SoundCloud</span>${hint}<button data-sc="find">${R ? (st.open ? 'refresh' : 'review') : '🔗 find'}</button>`;
    } else if (it.scPlay === null) {
      line = '<span class="sc-label">SoundCloud</span><span class="sc-badge none">no SoundCloud version</span><span class="sc-what">streams from Bandcamp</span><button data-sc="find">change</button><button data-sc="unlink" title="forget this decision">✕</button>';
    } else {
      const link = permalinkOf(it);
      line = `<span class="sc-label">SoundCloud</span><span class="sc-badge ok">linked</span>${it.scAuto ? '<span class="sc-badge auto" title="exact title + duration match, picked automatically — worth a glance">auto</span>' : ''}` +
        `<span class="sc-what" title="${escAttr(linkLabel(it).replace(/<[^>]+>/g, ''))}">${linkLabel(it)}</span>` +
        (link ? `<a href="${escAttr(link)}" target="_blank" rel="noopener">open ↗</a>` : '') +
        '<button data-sc="listen" title="listen to the linked upload">▶</button><button data-sc="find">change</button><button data-sc="unlink" title="remove the link">✕</button>';
    }
    return line + '<div class="sc-listen sc-frame" hidden></div>' + (st.open ? panelHtml(it, st) : '');
  }

  // Called from renderSelected()'s row template.
  window.scRowHtml = function (it) {
    if (!isBandcamp(it)) return '';
    return `<div class="sc-row" data-sc-key="${escAttr(it.key)}"><div class="sc-line">${rowInner(it)}</div></div>`;
  };

  function refreshRow(key) {
    const it = itemByKey(key);
    const host = document.querySelector(`.sc-row[data-sc-key="${CSS.escape(key)}"] .sc-line`);
    if (it && host) host.innerHTML = rowInner(it);
    updateSummary();
  }

  function setLink(it, val, meta, auto) {
    it.scPlay = val;
    if (val === null || !meta) delete it.scMeta; else it.scMeta = meta;
    if (auto && val !== null) it.scAuto = true; else delete it.scAuto;
    const st = panelOf(it.key);
    st.open = false; st.note = null;
    refreshRow(it.key);
    saveDraft();
  }
  function unlink(it) {
    delete it.scPlay; delete it.scMeta; delete it.scAuto;
    refreshRow(it.key);
    saveDraft();
  }

  // Search SoundCloud for one item. When the track already has a decision on
  // record (approvals.json, or the archive from an earlier show) it is adopted
  // so you never pick the same link twice.
  async function findFor(it, silent) {
    const st = panelOf(it.key);
    st.loading = true; st.error = null; st.note = null;
    if (!silent) st.open = true;
    refreshRow(it.key);
    let r;
    try {
      r = await post('/sc/find', { item: { key: it.key, albumId: it.albumId, trackId: it.trackId, artist: it.artist, title: it.title, url: it.url, duration: it.duration } });
      if (!r.ok) throw new Error(r.error || 'search failed');
      st.result = r;
      if (it.scPlay === undefined && r.current !== undefined) {
        const hit = r.candidates.find((c) => String(c.id) === String(r.current));
        it.scPlay = r.current;
        if (hit) it.scMeta = metaOf(hit); else if (r.currentTitle) it.scMeta = { title: r.currentTitle };
        st.adopted = r.currentSource;
        saveDraft();
      }
    } catch (e) {
      st.error = 'SoundCloud search failed: ' + (e.message || e);
      r = null;
    }
    st.loading = false;
    refreshRow(it.key);
    return r;
  }

  async function searchFor(it, q) {
    const st = panelOf(it.key);
    st.q = q; st.note = null;
    const r = await post('/sc/search', { q, ref: { artist: it.artist, title: it.title, duration: it.duration } });
    if (!r.ok) st.note = r.error || 'search failed'; else { st.extra = r.candidates; if (!r.candidates.length) st.note = 'no results for “' + q + '”'; }
    refreshRow(it.key);
  }

  // Delegated, so it survives renderSelected() rebuilding every row.
  el('selected').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sc], [data-sc-pick], [data-sc-prev]');
    if (!btn) return;
    const row = btn.closest('.sc-row');
    const it = row && itemByKey(row.dataset.scKey);
    if (!it) return;
    const st = panelOf(it.key);
    if (btn.dataset.scPrev != null) return togglePreview(btn);
    if (btn.dataset.scPick != null) {
      const c = [].concat((st.result && st.result.candidates) || [], st.extra || []).find((x) => String(x.id) === btn.dataset.scPick);
      if (c) setLink(it, c.id, metaOf(c), false);
      return;
    }
    const act = btn.dataset.sc;
    if (st.loading && (act === 'find' || act === 'search')) return;
    if (act === 'find') {
      if (st.result && !st.open && it.scPlay === undefined) { st.open = true; refreshRow(it.key); } // already searched — just open it
      else findFor(it, false);
    } else if (act === 'close') { st.open = false; refreshRow(it.key); }
    else if (act === 'none') setLink(it, null, null, false);
    else if (act === 'unlink') unlink(it);
    else if (act === 'listen') {
      const fr = row.querySelector('.sc-listen');
      if (fr.hidden) { fr.innerHTML = `<iframe src="${escAttr(widgetSrc(it.scPlay))}"></iframe>`; fr.hidden = false; btn.textContent = '■'; }
      else { fr.innerHTML = ''; fr.hidden = true; btn.textContent = '▶'; }
    } else if (act === 'search') {
      const q = row.querySelector('[data-sc-input="search"]').value.trim();
      if (q) searchFor(it, q);
    } else if (act === 'manual') {
      const p = parseManual(row.querySelector('[data-sc-input="manual"]').value);
      if (p.error) { st.note = p.error; refreshRow(it.key); } else setLink(it, p.val, null, false);
    }
  });
  el('selected').addEventListener('keydown', (e) => {
    const input = e.target.closest && e.target.closest('[data-sc-input]');
    if (!input || e.key !== 'Enter') return;
    e.preventDefault();
    const row = input.closest('.sc-row');
    row.querySelector(`[data-sc="${input.dataset.scInput}"]`).click();
  });

  function updateSummary() {
    const box = el('scSummary');
    if (!box) return;
    const bc = selected.filter(isBandcamp);
    if (!bc.length) { box.textContent = 'no Bandcamp tracks'; return; }
    const linked = bc.filter((it) => it.scPlay !== undefined && it.scPlay !== null).length;
    const none = bc.filter((it) => it.scPlay === null).length;
    const todo = bc.length - linked - none;
    box.innerHTML = `${linked} linked · ${none} none` + (todo ? ` · <span class="sc-unsaved">${todo} to do</span>` : ' ✓');
  }
  window.scAfterRender = updateSummary;

  // "Find links": search every Bandcamp track that has no decision yet, and
  // auto-link the airtight ones (exact title + duration, from the artist/label's
  // own SoundCloud account or exact artist). The rest are left for you to review.
  let findingAll = false;
  async function findAll() {
    if (findingAll) return;
    const todo = selected.filter((it) => isBandcamp(it) && it.scPlay === undefined);
    const out = el('scFindStatus'), btn = el('scFindAllBtn');
    if (!todo.length) { out.textContent = 'nothing left to find'; return; }
    findingAll = true; btn.disabled = true;
    let auto = 0, review = 0, empty = 0, adopted = 0, failed = 0;
    for (let i = 0; i < todo.length; i++) {
      const it = todo[i];
      out.textContent = `searching ${i + 1}/${todo.length}…`;
      const r = await findFor(it, true);
      if (!r) { failed++; continue; }
      if (it.scPlay !== undefined) adopted++; // already on record
      else if (r.tier === 'auto' && r.suggest) {
        const hit = r.candidates.find((c) => c.id === r.suggest);
        setLink(it, r.suggest, hit ? metaOf(hit) : null, true);
        auto++;
      } else if (r.candidates.length) review++; else empty++;
      if (r.live) await sleep(600);
    }
    findingAll = false; btn.disabled = false;
    out.textContent = [auto && `${auto} auto-linked`, adopted && `${adopted} already on record`, review && `${review} to review`, empty && `${empty} nothing found`, failed && `${failed} failed`].filter(Boolean).join(' · ') || 'done';
    saveDraft();
    updateSummary();
  }
  el('scFindAllBtn').addEventListener('click', findAll);

  // =====================================================================
  // 2. "SoundCloud links" tab — the backlog review
  // =====================================================================
  const LS_KEY = 'sb-sc-pending';
  const UNDO = '__undo__';
  const S = { loaded: false, loading: false, data: [], approvals: {}, pending: {}, mode: 'todo', idx: 0, query: '', extra: {}, note: '', saving: false };
  try { S.pending = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { S.pending = {}; }
  const persist = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(S.pending)); } catch (e) { /* ignore */ } };
  const dirtyCount = () => Object.keys(S.pending).length;

  // undefined = not decided yet; null = decided "no SoundCloud version"
  function decision(o) {
    if (o.key in S.pending) {
      if (S.pending[o.key] !== UNDO) return S.pending[o.key];
    } else if (o.key in S.approvals) return S.approvals[o.key];
    return o.tier === 'auto' && o.suggest ? o.suggest : undefined;
  }
  function list() {
    const q = S.query.trim().toLowerCase();
    if (q) {
      const terms = q.split(/\s+/);
      return S.data.filter((o) => {
        const hay = ((o.bcArtist || '') + ' ' + (o.bcTitle || '') + ' modem ' + (o.shows || []).join(' modem ')).toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
    }
    if (S.mode === 'nomatch') return S.data.filter((o) => !decision(o));
    return S.data.filter((o) => (S.mode === 'todo') === (decision(o) === undefined));
  }

  const tab = () => el('scTab');
  async function load() {
    if (S.loading) return;
    S.loading = true;
    tab().innerHTML = '<div class="empty">loading the Bandcamp tracks…</div>';
    try {
      const r = await (await fetch('/sc/queue')).json();
      if (!r.ok) throw new Error(r.error);
      S.data = r.entries; S.approvals = r.approvals; S.loaded = true;
      // drop pending entries the server already agrees with
      for (const k of Object.keys(S.pending)) if (S.pending[k] !== UNDO && JSON.stringify(S.approvals[k]) === JSON.stringify(S.pending[k])) delete S.pending[k];
      persist();
    } catch (e) {
      tab().innerHTML = `<div class="errors">could not load the SoundCloud queue: ${esc(e.message || e)}</div>`;
    }
    S.loading = false;
    if (S.loaded) render();
  }

  function pick(o, val) { S.pending[o.key] = val; persist(); render(); }
  function undo(o) {
    if (o.key in S.approvals) S.pending[o.key] = UNDO; else delete S.pending[o.key];
    persist(); render();
  }

  function shell() {
    tab().innerHTML = `
      <div class="sc-bar">
        <input class="sc-input" id="scQ" type="search" placeholder="find a release to link… (artist / title / modem N)">
        <span class="status" id="scPos"></span>
        <span class="grow"></span>
        <button id="scModeBtn"></button>
        <button id="scNoMatchBtn"></button>
        <button id="scPrev">‹</button><button id="scNext">›</button>
      </div>
      <div class="sc-bar">
        <span class="status" id="scTally"></span>
        <span class="grow"></span>
        <span class="status">keys: <kbd>1-5</kbd> pick · <kbd>0</kbd>/<kbd>n</kbd> none · <kbd>←</kbd><kbd>→</kbd></span>
        <button id="scFindNew" title="search SoundCloud for every Bandcamp track that isn’t in the queue yet — slow, runs in the background">⟲ find new matches</button>
        <button id="scSave" class="accent"></button>
      </div>
      <div id="scCard"></div>`;
    el('scQ').value = S.query;
    el('scQ').oninput = (e) => { S.query = e.target.value; S.idx = 0; render(); };
    el('scModeBtn').onclick = () => { S.mode = S.mode === 'done' ? 'todo' : 'done'; S.idx = 0; render(); };
    el('scNoMatchBtn').onclick = () => { S.mode = S.mode === 'nomatch' ? 'todo' : 'nomatch'; S.idx = 0; render(); };
    el('scPrev').onclick = () => nav(-1);
    el('scNext').onclick = () => nav(1);
    el('scFindNew').onclick = findNew;
    el('scSave').onclick = save;
  }
  function nav(d) { const L = list(); if (L.length) { S.idx = (S.idx + d + L.length) % L.length; render(); } }

  function render() {
    if (!el('scCard')) shell();
    const L = list();
    if (S.idx >= L.length) S.idx = Math.max(0, L.length - 1);
    const todoN = S.data.filter((o) => decision(o) === undefined).length;
    const doneN = S.data.length - todoN;
    const matched = S.data.filter((o) => decision(o)).length;
    const unmatchedN = S.data.filter((o) => !decision(o)).length;
    const searching = !!S.query.trim();
    el('scTally').textContent = `${todoN} to review · ${doneN} decided · ${matched} matched`;
    el('scModeBtn').textContent = S.mode === 'done' ? `‹ to review (${todoN})` : `decided (${doneN}) ›`;
    el('scNoMatchBtn').textContent = S.mode === 'nomatch' ? `‹ to review (${todoN})` : `⌀ no match (${unmatchedN})`;
    el('scModeBtn').classList.toggle('on', S.mode === 'done');
    el('scNoMatchBtn').classList.toggle('on', S.mode === 'nomatch');
    renderSaveBtn();
    el('scPos').textContent = !L.length ? ''
      : searching ? `found ${L.length} · ${S.idx + 1} of ${L.length}`
      : S.mode === 'nomatch' ? `no match · ${S.idx + 1} of ${L.length}`
      : S.mode === 'todo' ? `reviewing · ${S.idx + 1} of ${L.length} left`
      : `decided · ${S.idx + 1} of ${L.length}`;
    const card = el('scCard');
    if (!L.length) {
      card.innerHTML = '<div class="sc-donemsg">' + (searching ? `no release matches “${esc(S.query.trim())}”.`
        : S.mode === 'nomatch' ? '✔ every track has a SoundCloud match!'
        : S.mode === 'todo' ? '✔ nothing left to review!<br>press <b>save</b>, or open <b>decided</b> to double-check.'
        : 'nothing decided yet.') + '</div>';
      return;
    }
    const o = L[S.idx];
    const cur = decision(o);
    const isManual = typeof cur === 'string';
    const savedLabel = cur === undefined ? 'not decided yet'
      : cur === null ? 'picked: none (keeps Bandcamp)'
      : isManual ? 'picked: manual link'
      : (o.key in S.pending ? 'picked' : 'on record') + ': candidate #' + (o.candidates.findIndex((c) => c.id === cur) + 1 || '?');
    const extra = S.extra[o.key] || [];
    card.innerHTML = `
      <div class="sc-bc">
        ${o.bcArt ? `<img src="${escAttr(o.bcArt)}" alt="">` : '<div class="sc-bc-noimg"></div>'}
        <div class="meta"><div class="tagline">bandcamp · original</div>
          <div class="ttl">${esc(o.bcTitle)}</div><div class="sub">${esc(o.bcArtist)}</div>
          <div class="dur">${fmt(o.bcDuration)}${o.bcLabel && o.bcLabel.toLowerCase() !== (o.bcArtist || '').toLowerCase() ? ` · on <b>${esc(o.bcLabel)}</b>` : ''} · featured in modem ${(o.shows || []).join(', ')} · <a href="${escAttr(o.bcLink)}" target="_blank" rel="noopener">open ↗</a></div>
          ${o.bcEmbed ? `<iframe loading="lazy" src="${escAttr(o.bcEmbed)}"></iframe>` : ''}
        </div>
      </div>
      <div class="sc-h">${o.candidates.length ? 'soundcloud candidates — pick the matching one' : (o.fresh ? 'new since the last batch search — search below, or paste a link' : 'no candidates found automatically — search below, or paste a link')}</div>
      <div id="scCands">${o.candidates.map((c, i) => candHtml(c, i, o.bcDuration, cur, true)).join('')}</div>
      ${extra.length ? `<div class="sc-h">search results</div><div id="scExtra">${extra.map((c) => candHtml(c, 9, o.bcDuration, cur, true)).join('')}</div>` : ''}
      <div class="sc-manual"><input class="sc-input" id="scSearchQ" placeholder="search SoundCloud…" value="${escAttr(S.searchQ != null && S.searchQKey === o.key ? S.searchQ : [o.bcArtist, o.bcTitle].filter(Boolean).join(' '))}"><button id="scSearchBtn">search</button></div>
      <div class="sc-manual"><input class="sc-input" id="scMan" placeholder="or paste a SoundCloud track URL / id you found yourself…" value="${isManual ? escAttr(cur) : ''}"><button id="scManBtn">use this link</button></div>
      ${S.note ? `<div class="sc-note err" style="margin-top:4px">${esc(S.note)}</div>` : ''}
      <div class="sc-actions">
        <button class="warn" id="scNone">✗ none — keep Bandcamp (0 / n)</button>
        ${(S.mode === 'done' || searching) && cur !== undefined && (o.key in S.approvals || o.key in S.pending) ? '<button id="scUndo">↩ undo (re-review)</button>' : ''}
        <span class="sc-note">${savedLabel}</span>
      </div>`;
    const cands = o.candidates.concat(extra);
    wireCands(card, cands, (c) => { S.note = ''; pick(o, c.id); });
    el('scNone').onclick = () => { S.note = ''; pick(o, null); };
    const ub = el('scUndo'); if (ub) ub.onclick = () => undo(o);
    const setMan = () => {
      const p = parseManual(el('scMan').value);
      if (p.error) { S.note = p.error; render(); } else { S.note = ''; pick(o, p.val); }
    };
    el('scManBtn').onclick = setMan;
    el('scMan').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); setMan(); } };
    const doSearch = async () => {
      const q = el('scSearchQ').value.trim();
      if (!q) return;
      S.searchQ = q; S.searchQKey = o.key;
      el('scSearchBtn').disabled = true; el('scSearchBtn').textContent = 'searching…';
      const r = await post('/sc/search', { q, ref: { artist: o.bcArtist, title: o.bcTitle, duration: o.bcDuration } });
      S.note = r.ok ? (r.candidates.length ? '' : 'no results for “' + q + '”') : (r.error || 'search failed');
      S.extra[o.key] = r.ok ? r.candidates : [];
      render();
    };
    el('scSearchBtn').onclick = doSearch;
    el('scSearchQ').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } };
    window.scrollTo(0, 0);
  }

  function renderSaveBtn() {
    const btn = el('scSave');
    if (!btn || S.saving) return;
    const n = dirtyCount();
    btn.textContent = n ? `✔ save — ${n} unsaved` : '✔ save';
    btn.disabled = false;
  }

  async function pollJob(name, onTick) {
    for (;;) {
      await sleep(1500);
      let j;
      try { j = await (await fetch('/sc/job/' + name)).json(); } catch (e) { continue; }
      if (onTick) onTick(j);
      if (!j.running) return j;
    }
  }

  async function save() {
    const n = dirtyCount();
    if (!n || S.saving) { if (!n) el('scSave').textContent = 'nothing to save'; return; }
    S.saving = true;
    const btn = el('scSave'); btn.disabled = true; btn.textContent = 'saving…';
    const changes = {}, undoKeys = [];
    for (const [k, v] of Object.entries(S.pending)) { if (v === UNDO) undoKeys.push(k); else changes[k] = v; }
    const r = await post('/sc/approve', { changes, undo: undoKeys });
    if (!r.ok) { btn.textContent = '✗ ' + (r.error || 'error'); S.saving = false; setTimeout(renderSaveBtn, 3000); return; }
    // Saved to approvals.json (plus any airtight auto-matches the server folded in)
    // — re-read it rather than guessing. The site's own data only picks these up
    // when the next show is published (the pipeline runs apply-sc-matches.js).
    for (const k of Object.keys(changes)) S.approvals[k] = changes[k];
    for (const k of undoKeys) delete S.approvals[k];
    S.pending = {}; persist();
    try { const q = await (await fetch('/sc/queue')).json(); if (q.ok) { S.approvals = q.approvals; S.data = q.entries; } } catch (e) { /* keep the local fold */ }
    btn.textContent = '✔ saved — goes onto the site with your next publish';
    S.saving = false;
    render();
    setTimeout(renderSaveBtn, 4000);
  }

  async function findNew() {
    if (!confirm('Search SoundCloud for every Bandcamp track that isn’t in the queue yet (e.g. from newly-published shows)?\n\nThis can take several minutes — it runs in the background and you can keep working. The queue reloads when it finishes.')) return;
    const btn = el('scFindNew'); btn.disabled = true; btn.textContent = '⟲ starting…';
    const r = await post('/sc/run-find');
    if (!r.ok) { btn.textContent = '✗ ' + (r.error || 'error'); btn.disabled = false; return; }
    const j = await pollJob('sc-find', (t) => { btn.textContent = '⟲ ' + String(t.progress || 'searching…').replace(/^\s*…\s*/, '').slice(0, 40); });
    if (j.error) { btn.textContent = '✗ ' + j.error; btn.disabled = false; return; }
    btn.textContent = '✔ done — reloading';
    S.loaded = false; await load();
    btn.disabled = false; btn.textContent = '⟲ find new matches';
  }

  document.addEventListener('keydown', (e) => {
    if (el('panel-sc').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const L = list(); if (!L.length) return;
    const o = L[S.idx];
    if (e.key === 'ArrowRight') nav(1);
    else if (e.key === 'ArrowLeft') nav(-1);
    else if (e.key === 'n' || e.key === '0') { S.note = ''; pick(o, null); }
    else if (/^[1-5]$/.test(e.key)) { const c = o.candidates[Number(e.key) - 1]; if (c) { S.note = ''; pick(o, c.id); } }
  });
  // Picks live in localStorage until saved — warn before they're left behind.
  window.addEventListener('beforeunload', (e) => { if (dirtyCount()) { e.preventDefault(); e.returnValue = ''; } });

  window.scTabActivated = function () { if (!S.loaded) load(); };
  // the tab remembered from last time may be this one — switchTab() ran before this file loaded
  if (!el('panel-sc').hidden) window.scTabActivated();
})();
