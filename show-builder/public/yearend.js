// "Year-end list" tab — building the annual "50 best releases" list.
//
// Left: every LP / EP / compilation played in the year's shows (gathered by
// show-builder/year-end-gather.js). Listen to one (▶ — it plays through, track by
// track, in the same player as Scan / Arrange), then put it in the list (+) or out (✕).
// Right: the list, ranked — drag, or the ⤒ ↑ ↓ ⤓ buttons. The first 50 make it; a
// line marks the cut. "Generate HTML" gives the first 50, alphabetical, in the shape
// of the published lists, for radioštudent.
//
// Saved as you go (show-builder/year-end.js → data/year-end.json), travels with Sync.
// Ctrl+Z / Ctrl+Y undo / redo here while this tab is open.
// Loaded after index.html's inline script and shares its globals (el, esc, escAttr,
// formatTime, formatDurationLong, trackPlayerHtml, wireTrackPlayers).
(function () {
  'use strict';

  const TYPE_NAMES = { LP: 'LP', EP: 'EP', comp: 'compilation', single: 'single' };
  const S = {
    loaded: false, year: null, years: [], gathered: [],
    data: null, byKey: new Map(),
    decisions: {}, order: [], edits: {}, listSize: 50, editing: null,
    view: 'todo', types: { LP: true, EP: true, comp: true, single: false }, sort: 'played', q: '', group: true, hideOld: false,
    aliases: [], aliasOf: new Map(), aliasesOpen: false, // names that are one artist (for every year)
    open: new Map(), // "pool:key" / "list:key" -> { i: track playing }
    undo: [], redo: [], saveTimer: null, poll: null,
  };
  const host = () => el('yearendTab');
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

  // ---------- state ----------------------------------------------------------------
  const decision = (key) => S.decisions[key] || 'todo';
  const inList = () => S.order.filter((k) => S.decisions[k] === 'in' && S.byKey.has(k));
  const rankOf = (key) => { const i = inList().indexOf(key); return i < 0 ? null : i + 1; };

  function snapshot() { return JSON.stringify({ d: S.decisions, o: S.order, e: S.edits }); }
  function change(fn) {
    S.undo.push(snapshot());
    if (S.undo.length > 100) S.undo.shift();
    S.redo = [];
    fn();
    afterChange();
  }
  function afterChange() {
    // order holds exactly the "in" releases, in rank order
    const seen = new Set();
    S.order = S.order.filter((k) => S.decisions[k] === 'in' && !seen.has(k) && seen.add(k));
    Object.keys(S.decisions).forEach((k) => { if (S.decisions[k] === 'in' && !seen.has(k)) S.order.push(k); });
    renderAll();
    scheduleSave();
  }
  function restore(snap) { const j = JSON.parse(snap); S.decisions = j.d; S.order = j.o; S.edits = j.e || {}; afterChange(); }
  window.yearendUndo = () => { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); };
  window.yearendRedo = () => { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); };

  function scheduleSave() {
    clearTimeout(S.saveTimer);
    const s = el('yeSaved'); if (s) s.textContent = 'saving…';
    S.saveTimer = setTimeout(async () => {
      try {
        const j = await post('/ye/save', { year: S.year, decisions: S.decisions, order: S.order, edits: S.edits });
        if (el('yeSaved')) el('yeSaved').textContent = j.ok ? 'saved' : ('not saved: ' + (j.error || ''));
      } catch (e) { if (el('yeSaved')) el('yeSaved').textContent = 'not saved: ' + e.message; }
    }, 500);
  }

  async function load(year) {
    const j = await fetch('/ye/state?year=' + year).then((r) => r.json());
    S.year = j.year; S.data = j; S.listSize = j.listSize || 50;
    S.byKey = new Map((j.candidates || []).map((c) => [c.key, c]));
    S.decisions = j.decisions || {}; S.order = j.order || []; S.edits = j.edits || {}; S.editing = null;
    setAliases(j.aliases);
    S.undo = []; S.redo = []; S.open.clear();
    renderAll();
  }

  // a release with the names fixed by hand (see the ✎ editor in the list)
  // A compilation reads "V/A", its label the one tagged or else the page it's on — as on the
  // list (year-end.js's withEdits()), unless its artist was fixed by hand.
  function named(c) {
    const e = S.edits[c.key];
    const out = { ...c };
    if (e) {
      ['artist', 'title', 'label'].forEach((f) => { if (typeof e[f] === 'string' && e[f].trim() !== '') out[f] = e[f].trim(); });
      if (e.label === '') out.label = null;
      out.fixed = true;
    }
    if (c.type === 'comp' && !(e && typeof e.artist === 'string' && e.artist.trim())) {
      if (!out.label && !(e && e.label === '')) out.label = c.account || c.artist;
      out.artist = 'V/A';
    }
    return out;
  }

  // ---------- small pieces -----------------------------------------------------------
  const monthYear = (d) => { if (!d) return ''; const x = new Date(d + 'T00:00:00'); return isNaN(x) ? '' : x.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }); };
  const typeBadge = (c) => `<span class="ye-type t-${escAttr(c.type)}" title="${escAttr(TYPE_NAMES[c.type] || c.type)}${c.setType && c.source === 'soundcloud' ? ' (SoundCloud: ' + escAttr(c.setType) + ')' : ''}">${esc(c.type === 'comp' ? 'comp' : c.type)}</span>`;
  // the label is the artist themselves (the same name, a "same artist" name, or one of a
  // collaboration's names) → self-released, as on every list since 2017. Same rule as
  // year-end.js's selfReleased(), which writes the HTML.
  function selfReleased(c) {
    if (!c.label) return true;
    if (c.type === 'comp') return false; // a compilation's label is a label
    const names = [c.artist, ...String(c.artist || '').split(/\s+(?:&|and|x|\+|feat\.?|ft\.?|with)\s+|\s*,\s*/i)];
    const label = artistKey(c.label);
    return names.some((n) => n && artistKey(n) === label);
  }
  const labelText = (c) => (selfReleased(c) ? '<i>self-released</i>' : esc(c.label));
  const sub = (c) => esc(c.artist || '?') + ` <span class="ye-label">· ${labelText(c)}</span>` + (c.fixed ? ' <span class="ye-fixed" title="names fixed by hand">✎</span>' : '');
  function facts(c) {
    const bits = [typeBadge(c)];
    if (c.trackCount) bits.push(`${c.trackCount} track${c.trackCount === 1 ? '' : 's'}`);
    if (c.duration) bits.push(formatDurationLong(c.duration));
    if (c.releaseDate) {
      const old = c.year && c.year < S.year;
      bits.push(old ? `<span class="ye-old" title="released ${esc(c.releaseDate)}">⚠ released ${esc(monthYear(c.releaseDate))}</span>` : esc(monthYear(c.releaseDate)));
    }
    const shows = (c.shows || []).map((s) => `#${s.number}${s.tracks.length > 1 ? ` <span class="ye-x">×${s.tracks.length}</span>` : ''}`).join(' ');
    if (shows) bits.push(`<span class="ye-played" title="played in these shows (×N: that many of its tracks)">♪ ${shows}</span>`);
    else if (c.addedByHand) bits.push('<span class="ye-hand" title="added from a link, not played in a show">added by hand</span>');
    bits.push(`<a href="${escAttr(c.url)}" target="_blank" rel="noopener" title="open on ${c.source === 'soundcloud' ? 'SoundCloud' : 'Bandcamp'}">${c.source === 'soundcloud' ? 'sc' : 'bc'} ↗</a>`);
    (c.alsoOn || []).forEach((a) => bits.push(`<a href="${escAttr(a.url)}" target="_blank" rel="noopener" title="the same release on ${a.source === 'soundcloud' ? 'SoundCloud' : 'Bandcamp'}">also ${a.source === 'soundcloud' ? 'sc' : 'bc'} ↗</a>`));
    return bits.join(' <span class="ye-dot">·</span> ');
  }
  const art = (c, where) => `<img class="ye-art" src="${escAttr(c.artwork || '')}" loading="lazy" data-play="${escAttr(where)}" data-key="${escAttr(c.key)}" title="listen" onerror="this.style.visibility='hidden'">`;
  const playBtn = (c, where) => {
    const open = S.open.has(where + ':' + c.key);
    return `<button class="ye-play${open ? ' on' : ''}" data-play="${escAttr(where)}" data-key="${escAttr(c.key)}" title="${open ? 'stop' : 'listen (plays through the release)'}">${open ? '■' : '▶'}</button>`;
  };

  // ---------- the candidates ----------------------------------------------------------
  // released before the year of the list (a release with no known date isn't)
  const isOld = (c) => !!(c.year && c.year < S.year);
  // one artist, however it's spelled (case, accents, spaces, invisible marks — Bandcamp's
  // "Computer man" account has left-to-right marks in it)
  const spelled = (a) => String(a || '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/\p{Cf}/gu, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
  // …and names that are one artist (the "same artist" list): all go under the group's first name
  const artistKey = (a) => { const k = spelled(a); return S.aliasOf.get(k) || k; };
  function setAliases(groups) {
    S.aliases = groups || [];
    S.aliasOf = new Map();
    S.aliases.forEach((g) => { const head = spelled(g[0]); g.forEach((n) => S.aliasOf.set(spelled(n), head)); });
  }
  const abc = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base', numeric: true });
  const lastShow = (c) => Math.max(0, ...(c.shows || []).map((s) => s.number));
  // releases with no date go last, whichever way the dates run
  const byDate = (dir) => (a, b) => (!a.releaseDate) - (!b.releaseDate) || dir * String(a.releaseDate || '').localeCompare(String(b.releaseDate || ''));
  const SORTS = {
    played: (a, b) => (b.playedTracks - a.playedTracks) || ((b.shows || []).length - (a.shows || []).length) || byDate(-1)(a, b),
    recent: (a, b) => (lastShow(b) - lastShow(a)) || (b.playedTracks - a.playedTracks),
    newest: byDate(-1),
    oldest: byDate(1),
    artist: (a, b) => abc(a.artist, b.artist) || abc(a.title, b.title),
    title: (a, b) => abc(a.title, b.title) || abc(a.artist, b.artist),
    // self-released last
    label: (a, b) => selfReleased(a) - selfReleased(b) || abc(a.label, b.label) || abc(a.artist, b.artist),
  };
  // the releases on the left, filtered and sorted — as groups: with "group by artist" on,
  // an artist's releases sit together, in the order of the artist's best-placed one
  function visible() {
    const q = S.q.trim().toLowerCase();
    const list = [...S.byKey.values()].map((raw) => ({ raw, c: named(raw) })).filter(({ raw, c }) => {
      if (S.view !== 'all' && decision(raw.key) !== S.view) return false;
      if (!S.types[raw.type]) return false;
      if (S.hideOld && isOld(raw)) return false;
      if (q && !`${c.title} ${c.artist} ${c.label || ''} ${raw.account || ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
    const by = SORTS[S.sort] || SORTS.played;
    const cmp = (x, y) => by(x.c, y.c);
    if (!S.group) return list.sort(cmp).map((x) => ({ name: null, items: [x.raw] }));
    const groups = new Map();
    for (const x of list) {
      const k = artistKey(x.c.artist) || x.raw.key;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
    return [...groups.values()]
      .map((g) => g.sort(cmp))
      .sort((g, h) => cmp(g[0], h[0]))
      // the heading: every name the artist's releases go under ("Dj-c / Computer man")
      .map((g) => ({
        name: g.length > 1 ? [...new Map(g.map((x) => [spelled(x.c.artist), x.c.artist])).values()].join(' / ') : null,
        items: g.map((x) => x.raw),
      }));
  }
  function counts() {
    const v = { todo: 0, in: 0, out: 0, all: 0 }, t = { LP: 0, EP: 0, comp: 0, single: 0 };
    let old = 0;
    for (const c of S.byKey.values()) {
      const inView = S.view === 'all' || decision(c.key) === S.view;
      if (inView && S.types[c.type] && isOld(c)) old++;
      if (S.hideOld && isOld(c)) continue;
      // the views count the types shown; the types count within the view
      if (S.types[c.type]) { v.all++; v[decision(c.key)]++; }
      if (inView) t[c.type] = (t[c.type] || 0) + 1;
    }
    return { v, t, old };
  }

  // how the left side is shown: kept on this computer between visits
  const PREFS = 'sb-ye-view';
  function savePrefs() {
    try { localStorage.setItem(PREFS, JSON.stringify({ view: S.view, types: S.types, sort: S.sort, group: S.group, hideOld: S.hideOld })); } catch (e) { /* private mode */ }
  }
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) || 'null');
      if (!p) return;
      if (p.view) S.view = p.view;
      if (p.types) Object.assign(S.types, p.types);
      if (SORTS[p.sort]) S.sort = p.sort;
      if (typeof p.group === 'boolean') S.group = p.group;
      if (typeof p.hideOld === 'boolean') S.hideOld = p.hideOld;
    } catch (e) { /* ignore */ }
  }
  function candRow(raw) {
    const c = named(raw);
    const d = decision(c.key), rank = d === 'in' ? rankOf(c.key) : null;
    const acts = d === 'in'
      ? `<span class="ye-rank-pill${rank > S.listSize ? ' below' : ''}" title="its place in the list">#${rank}</span><button class="ye-btn" data-act="todo" data-key="${escAttr(c.key)}" title="take it out of the list (back to to do)">remove</button>`
      : d === 'out'
        ? `<span class="ye-out-pill">out</span><button class="ye-btn" data-act="todo" data-key="${escAttr(c.key)}" title="back to to do">↺</button>`
        : `<button class="ye-btn ye-in" data-act="in" data-key="${escAttr(c.key)}" title="put it in the list (at the bottom)">+ list</button><button class="ye-btn ye-x-btn" data-act="out" data-key="${escAttr(c.key)}" title="not for the list">✕</button>`;
    return `<div class="ye-cand d-${d}" data-key="${escAttr(c.key)}">
      <div class="ye-row">
        ${art(c, 'pool')}
        <div class="ye-meta">
          <div class="ye-title" title="${escAttr(c.title)}">${esc(c.title || 'untitled')}</div>
          <div class="ye-sub">${sub(c)}</div>
          <div class="ye-facts">${facts(c)}</div>
        </div>
        ${playBtn(c, 'pool')}
        <div class="ye-acts">${acts}</div>
      </div>
      ${S.open.has('pool:' + c.key) ? `<div class="ye-tracks" data-where="pool" data-key="${escAttr(c.key)}"></div>` : ''}
    </div>`;
  }

  // ---------- the list -------------------------------------------------------------------
  function listRow(raw, i) {
    const c = named(raw);
    const ed = S.editing === c.key;
    return `<div class="ye-item${i >= S.listSize ? ' below' : ''}" data-key="${escAttr(c.key)}" draggable="${ed ? 'false' : 'true'}">
      <div class="ye-row">
        <span class="ye-rank">${i + 1}</span>
        ${art(c, 'list')}
        <div class="ye-meta">
          <div class="ye-title" title="${escAttr(c.title)}">${esc(c.title || 'untitled')}</div>
          <div class="ye-sub">${sub(c)}</div>
        </div>
        ${typeBadge(c)}
        ${playBtn(c, 'list')}
        <div class="ye-move">
          <button data-move="top" data-key="${escAttr(c.key)}" title="to the top">⤒</button><button data-move="up" data-key="${escAttr(c.key)}" title="up one">↑</button><button data-move="down" data-key="${escAttr(c.key)}" title="down one">↓</button><button data-move="bottom" data-key="${escAttr(c.key)}" title="to the bottom">⤓</button>
        </div>
        <button class="ye-btn${ed ? ' on' : ''}" data-edit="${escAttr(c.key)}" title="fix the artist / title / label as they go on the list">✎</button>
        <button class="ye-btn" data-act="todo" data-key="${escAttr(c.key)}" title="take it out of the list (back to to do)">✕</button>
      </div>
      ${ed ? editor(raw) : ''}
      ${S.open.has('list:' + c.key) ? `<div class="ye-tracks" data-where="list" data-key="${escAttr(c.key)}"></div>` : ''}
    </div>`;
  }
  // the names as they go on the list; empty = as found (the label: empty = self-released)
  function editor(c) {
    const e = S.edits[c.key] || {};
    const f = (field, ph) => `<label>${field}<input class="sc-input" data-field="${field}" value="${escAttr(e[field] != null ? e[field] : c[field] || '')}" placeholder="${escAttr(ph)}"></label>`;
    const ln = (field, name) => `<label>${name}<input class="sc-input" data-field="${field}" value="${escAttr(e[field] || '')}" placeholder="automatic"></label>`;
    return `<div class="ye-editor" data-key="${escAttr(c.key)}">
      ${f('artist', c.artist || 'artist')}${f('title', c.title || 'title')}${f('label', 'self-released')}
      ${ln('artistLink', 'artist link')}${ln('labelLink', 'label link')}<span></span>
      <div class="ye-editor-btns"><button class="ye-btn accent" data-edit-save="${escAttr(c.key)}">save</button><button class="ye-btn" data-edit-reset="${escAttr(c.key)}" title="back to the names (and links) as found">as found</button><button class="ye-btn" data-edit="${escAttr(c.key)}">close</button></div>
      <div class="ye-x">As found: ${esc(c.artist || '?')} – ${esc(c.title || '?')} (${labelText(c)}). A label that is the artist (or one of their names) goes on the list as self-released.
        Links (empty = automatic): the one used for that name on an earlier list, else its SoundCloud profile (uploads, the Bandcamp page's links, or a SoundCloud account with exactly that name), else the Bandcamp page. Paste one to choose it yourself.</div>
    </div>`;
  }
  function saveEdit(key) {
    const box = host().querySelector(`.ye-editor[data-key="${cssEsc(key)}"]`);
    if (!box) return;
    const c = S.byKey.get(key);
    const e = {};
    box.querySelectorAll('input[data-field]').forEach((i) => {
      const f = i.dataset.field, v = i.value.trim();
      if (f === 'label') { if (v !== (c.label || '')) e.label = v; } // '' = self-released
      else if (f === 'artistLink' || f === 'labelLink') { if (v) e[f] = v; } // empty = automatic
      else if (v && v !== (c[f] || '')) e[f] = v;
    });
    change(() => { if (Object.keys(e).length) S.edits[key] = e; else delete S.edits[key]; S.editing = null; });
  }

  const cutLine = () => `<div class="ye-cut" title="everything above this line makes the list"><span>${S.listSize} — the cut</span></div>`;

  // ---------- render ------------------------------------------------------------------------
  function renderAll() {
    const box = host();
    if (!box) return;
    const playing = rememberPlaying();
    if (!box.querySelector('.ye-head')) box.innerHTML = shell();
    renderHead();
    renderPool();
    renderList();
    reopenPlayers(playing);
  }
  function shell() {
    return `<div class="ye-head">
      <label class="ye-year">Year <select id="yeYear"></select></label>
      <button id="yeGather" class="primary"></button>
      <span id="yeGatherStatus" class="status"></span>
      <span class="grow"></span>
      <button id="yeUndo" title="undo (Ctrl+Z)">↶ Undo</button><button id="yeRedo" title="redo (Ctrl+Y)">↷ Redo</button>
      <span id="yeSaved" class="status"></span>
    </div>
    <div class="ye-cols">
      <section class="ye-pool">
        <div class="ye-bar">
          <div class="ye-seg" id="yeViews"></div>
          <div class="ye-seg" id="yeTypes"></div>
          <input id="yeSearch" class="sc-input" placeholder="search title / artist / label">
        </div>
        <div class="ye-bar">
          <label class="ye-sortlbl">sort
            <select id="yeSort" title="the order of the releases on this side">
              <option value="played">most played</option>
              <option value="recent">played most recently</option>
              <option value="newest">release date, newest first</option>
              <option value="oldest">release date, oldest first</option>
              <option value="artist">artist A–Z</option>
              <option value="title">title A–Z</option>
              <option value="label">label A–Z</option>
            </select>
          </label>
          <div class="ye-seg" id="yeOpts"></div>
          <button id="yeAliasBtn" class="ye-btn" title="names that are one artist — grouped together">same artist…</button>
        </div>
        <div id="yeAliasBox" class="ye-aliasbox" hidden>
          <div class="ye-x">One artist per line, its names separated by <b>=</b> — e.g. <code>Computer man = Computer doctor = Dj-c</code>. Their releases are grouped together (for every year). Case, accents and spaces don't matter.</div>
          <textarea id="yeAliasText" rows="4" spellcheck="false"></textarea>
          <div class="actions"><button id="yeAliasSave" class="ye-btn accent">save</button><button id="yeAliasClose" class="ye-btn">close</button><span id="yeAliasStatus" class="status"></span></div>
        </div>
        <div class="ye-addrow">
          <input id="yeAddUrl" class="sc-input" placeholder="a release that wasn't in a show: paste its Bandcamp / SoundCloud link">
          <button id="yeAddBtn" title="look it up and put it in the list">+ add to the list</button>
        </div>
        <div id="yeAddStatus" class="status"></div>
        <div id="yePool"></div>
      </section>
      <section class="ye-list">
        <div class="ye-list-head"><h2>The list</h2><span id="yeCount" class="ye-count"></span></div>
        <div class="ye-hint">Drag to rank (or ⤒ ↑ ↓ ⤓). The first ${S.listSize} make it; on radioštudent they're listed alphabetically.</div>
        <div id="yeList"></div>
        <div class="actions"><button id="yeHtmlBtn" class="primary">Generate HTML (first ${S.listSize}, A–Z)</button><span id="yeHtmlStatus" class="status"></span></div>
        <div id="yeOut" hidden>
          <textarea id="yeOutHtml" readonly rows="10"></textarea>
          <div class="actions"><button id="yeCopyHtml">Copy HTML</button><button id="yeCopyText">Copy as plain list</button></div>
          <textarea id="yeOutText" readonly rows="6"></textarea>
        </div>
      </section>
    </div>`;
  }
  function renderHead() {
    const sel = el('yeYear');
    const years = [...new Set([...(S.years || []), S.year])].filter(Boolean).sort((a, b) => b - a);
    sel.innerHTML = years.map((y) => `<option value="${y}"${y === S.year ? ' selected' : ''}>${y}${S.gathered.includes(y) ? '' : ' (not gathered)'}</option>`).join('');
    const has = S.byKey.size > 0;
    el('yeGather').textContent = has ? `↻ Gather again` : `Gather the releases from ${S.year}'s shows`;
    el('yeGather').title = `look through every show from ${S.year} for its LPs, EPs and compilations (a few minutes the first time; your picks stay)`;
    if (!el('yeGatherStatus').dataset.busy) {
      el('yeGatherStatus').textContent = has
        ? `${S.byKey.size} releases from ${(S.data.shows || []).length} shows · gathered ${new Date(S.data.gatheredAt).toLocaleString()}`
        : '';
    }
    el('yeUndo').disabled = !S.undo.length; el('yeRedo').disabled = !S.redo.length;
  }
  function renderPool() {
    const { v, t, old } = counts();
    el('yeOpts').innerHTML =
      `<button class="ye-seg-btn${S.group ? ' on' : ''}" data-opt="group" title="keep each artist's releases together">group by artist</button>` +
      `<button class="ye-seg-btn${S.hideOld ? ' on' : ''}" data-opt="hideOld" title="hide everything released before ${S.year} (a release with no known date stays)">hide released before ${S.year} <span>${old}</span></button>`;
    el('yeViews').innerHTML = [['todo', 'to do'], ['in', 'in the list'], ['out', 'out'], ['all', 'all']]
      .map(([k, n]) => `<button class="ye-seg-btn${S.view === k ? ' on' : ''}" data-view="${k}">${n} <span>${v[k]}</span></button>`).join('');
    el('yeTypes').innerHTML = ['LP', 'EP', 'comp', 'single']
      .map((k) => `<button class="ye-seg-btn${S.types[k] ? ' on' : ''}" data-type="${k}" title="show / hide ${TYPE_NAMES[k]}s">${k === 'single' ? 'singles' : k} <span>${t[k] || 0}</span></button>`).join('');
    el('yeSort').value = S.sort;
    if (document.activeElement !== el('yeSearch')) el('yeSearch').value = S.q;
    const pool = el('yePool');
    if (!S.byKey.size) {
      pool.innerHTML = `<div class="empty">Nothing gathered for ${S.year} yet. <b>Gather</b> looks through every show from ${S.year} and lists the LPs, EPs and compilations played in them (singles are kept too, but hidden). The first time takes a few minutes.</div>`;
      return;
    }
    const groups = visible();
    pool.innerHTML = groups.length
      ? groups.map((g) => (g.name
        ? `<div class="ye-group"><div class="ye-group-head">${esc(g.name)} <span>· ${g.items.length} releases</span></div>${g.items.map(candRow).join('')}</div>`
        : g.items.map(candRow).join(''))).join('')
      : '<div class="empty">Nothing here.</div>';
  }
  function renderList() {
    const keys = inList();
    const n = keys.length;
    el('yeCount').innerHTML = `<b>${Math.min(n, S.listSize)}</b> / ${S.listSize}${n > S.listSize ? ` <span class="ye-x">+${n - S.listSize} below the cut</span>` : n < S.listSize ? ` <span class="ye-x">${S.listSize - n} to go</span>` : ' ✓'}`;
    const box = el('yeList');
    if (!n) { box.innerHTML = '<div class="empty">Nothing in the list yet — <b>+ list</b> on the left.</div>'; return; }
    let html = '';
    keys.forEach((k, i) => {
      if (i === S.listSize) html += cutLine();
      html += listRow(S.byKey.get(k), i);
    });
    if (n === S.listSize) html += cutLine();
    box.innerHTML = html;
    wireDrag(box);
  }

  // ---------- the cut line and ranks, without re-rendering (while dragging) ---------------
  function renumber(box) {
    box.querySelectorAll('.ye-cut').forEach((n) => n.remove());
    const items = [...box.querySelectorAll('.ye-item')];
    items.forEach((n, i) => {
      n.querySelector('.ye-rank').textContent = String(i + 1);
      n.classList.toggle('below', i >= S.listSize);
    });
    if (items.length >= S.listSize) items[S.listSize - 1].insertAdjacentHTML('afterend', cutLine());
  }

  // ---------- drag to rank (moves the rows themselves, like Arrange — a playing release keeps playing)
  function wireDrag(box) {
    let dragging = null;
    box.querySelectorAll('.ye-item').forEach((item) => {
      item.addEventListener('dragstart', (e) => {
        if (e.target.closest('.ye-tracks')) { e.preventDefault(); return; }
        dragging = item;
        S.undo.push(snapshot()); S.redo = [];
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => {
        item.classList.remove('dragging');
        dragging = null;
        S.order = [...box.querySelectorAll('.ye-item')].map((n) => n.dataset.key);
        renderPool(); renderHead();
        scheduleSave();
      });
    });
    box.ondragover = (e) => {
      e.preventDefault();
      if (!dragging) return;
      const items = [...box.querySelectorAll('.ye-item')].filter((n) => n !== dragging);
      let after = null, best = -Infinity;
      for (const n of items) {
        const r = n.getBoundingClientRect();
        const off = e.clientY - r.top - r.height / 2;
        if (off < 0 && off > best) { best = off; after = n; }
      }
      const prev = new Map(items.map((n) => [n, n.getBoundingClientRect().top]));
      if (after == null) box.appendChild(dragging); else if (after !== dragging.nextElementSibling) box.insertBefore(dragging, after); else return;
      renumber(box);
      items.forEach((n) => {
        const dy = prev.get(n) - n.getBoundingClientRect().top;
        if (!dy) return;
        n.style.transition = 'none'; n.style.transform = `translateY(${dy}px)`;
        requestAnimationFrame(() => { n.style.transition = ''; n.style.transform = ''; });
      });
    };
    box.ondrop = (e) => e.preventDefault();
  }

  function move(key, dir) {
    change(() => {
      const keys = inList();
      const i = keys.indexOf(key);
      if (i < 0) return;
      keys.splice(i, 1);
      const j = dir === 'top' ? 0 : dir === 'bottom' ? keys.length : dir === 'up' ? Math.max(0, i - 1) : Math.min(keys.length, i + 1);
      keys.splice(j, 0, key);
      S.order = keys;
    });
  }
  function decide(key, d) {
    change(() => {
      if (d === 'todo') delete S.decisions[key]; else S.decisions[key] = d;
      if (d === 'in' && !S.order.includes(key)) S.order.push(key);
      if (d !== 'in') S.order = S.order.filter((k) => k !== key);
    });
  }

  // ---------- listening: a release plays through, track by track ----------------------------
  function rememberPlaying() {
    const out = [];
    host().querySelectorAll('.ye-tracks').forEach((t) => {
      const a = t.querySelector('audio');
      out.push({ id: t.dataset.where + ':' + t.dataset.key, src: a && a.src, time: a ? a.currentTime : 0, playing: !!(a && !a.paused) });
    });
    return out;
  }
  function reopenPlayers(before) {
    host().querySelectorAll('.ye-tracks').forEach((box) => {
      const id = box.dataset.where + ':' + box.dataset.key;
      const was = (before || []).find((b) => b.id === id);
      renderTracks(box, was);
    });
  }
  async function trackList(c) {
    const ok = (c.tracks || []).length && c.tracks.every((t) => t.url && t.title);
    if (ok || c.kind !== 'set') return c.tracks || [];
    const j = await post('/ye/tracks', { year: S.year, key: c.key });
    if (j.ok) c.tracks = j.tracks;
    return c.tracks || [];
  }
  function renderTracks(box, resume) {
    const c = S.byKey.get(box.dataset.key);
    const state = S.open.get(box.dataset.where + ':' + c.key) || { i: 0 };
    const playedIds = new Map();
    (c.shows || []).forEach((s) => s.tracks.forEach((id) => playedIds.set(String(id), (playedIds.get(String(id)) || []).concat(s.number))));
    box.innerHTML = `<div class="ye-now"></div><div class="ye-tl">${(c.tracks || []).map((t, i) => {
      const shows = playedIds.get(String(t.id));
      return `<div class="ye-t${i === state.i ? ' cur' : ''}${t.playable === false ? ' dead' : ''}" data-i="${i}">
        <span class="ye-t-n">${i + 1}</span><span class="ye-t-title">${esc(t.title || '…')}${t.artist && t.artist !== c.artist ? ` <span class="ye-label">– ${esc(t.artist)}</span>` : ''}</span>
        ${shows ? `<span class="ye-played" title="played in these shows">♪ ${shows.map((n) => '#' + n).join(' ')}</span>` : ''}
        <span class="ye-t-dur">${t.duration ? formatTime(t.duration) : ''}</span></div>`;
    }).join('') || '<div class="status">loading tracks…</div>'}</div>`;
    box.querySelectorAll('.ye-t').forEach((row) => row.addEventListener('click', () => playTrack(box, Number(row.dataset.i))));
    if (resume && resume.src) {
      const now = box.querySelector('.ye-now');
      now.innerHTML = trackPlayerHtml(resume.src);
      wireTrackPlayers(now);
      const a = now.querySelector('audio');
      a.addEventListener('ended', () => playTrack(box, state.i + 1));
      a.addEventListener('loadedmetadata', () => { a.currentTime = resume.time || 0; }, { once: true });
      if (resume.playing) a.play().catch(() => {});
    }
  }
  async function playTrack(box, i) {
    const c = S.byKey.get(box.dataset.key);
    const id = box.dataset.where + ':' + c.key;
    const tracks = c.tracks || [];
    if (i >= tracks.length) return; // the end of the release
    const t = tracks[i];
    if (t.playable === false) return playTrack(box, i + 1);
    S.open.set(id, { i });
    box.querySelectorAll('.ye-t').forEach((r) => r.classList.toggle('cur', Number(r.dataset.i) === i));
    const now = box.querySelector('.ye-now');
    now.innerHTML = '<div class="status">loading…</div>';
    try {
      const j = await post('/preview-stream', { item: { source: c.source === 'soundcloud' ? 'soundcloud' : 'bandcamp-library', url: t.url, trackId: t.id } });
      if (!S.open.has(id)) return; // closed meanwhile
      if (!j.ok || !j.url) throw new Error(j.error || 'no stream');
      now.innerHTML = trackPlayerHtml(j.url);
      wireTrackPlayers(now);
      const a = now.querySelector('audio');
      a.addEventListener('ended', () => playTrack(box, i + 1));
      a.play().catch(() => {});
    } catch (e) {
      // no direct stream (some SoundCloud tracks): the platform's own player for this
      // track, which also goes on to the next one when it ends
      if (c.source !== 'soundcloud') {
        now.innerHTML = `<div class="status">can't play this one here — <a href="${escAttr(t.url)}" target="_blank" rel="noopener">open it ↗</a></div>`;
        return;
      }
      if (activeTrackAudio) activeTrackAudio.pause();
      now.innerHTML = `<iframe class="ye-embed" height="120" allow="autoplay" src="https://w.soundcloud.com/player/?url=${encodeURIComponent(t.url)}&auto_play=true&visual=false&hide_related=true&show_comments=false"></iframe>`;
      try {
        await scApi();
        const frame = now.querySelector('iframe');
        if (frame && S.open.has(id)) SC.Widget(frame).bind(SC.Widget.Events.FINISH, () => { if (S.open.has(id)) playTrack(box, i + 1); });
      } catch (err) { /* the widget still plays, it just won't go on by itself */ }
    }
  }
  function scApi() {
    if (window.SC && SC.Widget) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://w.soundcloud.com/player/api.js';
      s.onload = resolve; s.onerror = () => reject(new Error('could not load the SoundCloud player'));
      document.head.appendChild(s);
    });
  }
  async function togglePlay(where, key) {
    const id = where + ':' + key;
    if (S.open.has(id)) {
      S.open.delete(id);
      const box = host().querySelector(`.ye-tracks[data-where="${where}"][data-key="${cssEsc(key)}"]`);
      if (box) { const a = box.querySelector('audio'); if (a) a.pause(); box.remove(); }
      updatePlayButtons();
      return;
    }
    // one release at a time: close the others (their audio would be paused anyway)
    [...S.open.keys()].forEach((k) => { S.open.delete(k); const [w, ...rest] = k.split(':'); const b = host().querySelector(`.ye-tracks[data-where="${w}"][data-key="${cssEsc(rest.join(':'))}"]`); if (b) { const a = b.querySelector('audio'); if (a) a.pause(); b.remove(); } });
    S.open.set(id, { i: 0 });
    const c = S.byKey.get(key);
    const holder = host().querySelector(`${where === 'list' ? '.ye-item' : '.ye-cand'}[data-key="${cssEsc(key)}"]`);
    if (!holder) return;
    holder.insertAdjacentHTML('beforeend', `<div class="ye-tracks" data-where="${where}" data-key="${escAttr(key)}"></div>`);
    const box = holder.querySelector('.ye-tracks');
    updatePlayButtons();
    renderTracks(box, null);
    await trackList(c);
    if (!S.open.has(id)) return;
    renderTracks(box, null);
    playTrack(box, firstPlayable(c));
  }
  const firstPlayable = (c) => Math.max(0, (c.tracks || []).findIndex((t) => t.playable !== false));
  function updatePlayButtons() {
    host().querySelectorAll('.ye-play').forEach((b) => {
      const on = S.open.has(b.dataset.play + ':' + b.dataset.key);
      b.classList.toggle('on', on); b.textContent = on ? '■' : '▶'; b.title = on ? 'stop' : 'listen (plays through the release)';
    });
  }

  // ---------- gather ------------------------------------------------------------------------
  async function gather() {
    const j = await post('/ye/gather', { year: S.year });
    if (!j.ok) { el('yeGatherStatus').textContent = j.error || 'could not start'; return; }
    pollGather();
  }
  function pollGather() {
    clearTimeout(S.poll);
    const st = el('yeGatherStatus');
    fetch('/ye/gather-status').then((r) => r.json()).then(async (s) => {
      if (s.running) {
        st.dataset.busy = '1';
        st.textContent = '⏳ ' + (s.progress || s.step || 'gathering…');
        el('yeGather').disabled = true;
        S.poll = setTimeout(pollGather, 1500);
        return;
      }
      delete st.dataset.busy;
      el('yeGather').disabled = false;
      if (s.error) { st.textContent = '✖ ' + s.error + ' — ' + (s.log || []).slice(-3).join(' / '); return; }
      if (s.done) {
        const yr = await fetch('/ye/years').then((r) => r.json());
        S.years = yr.years || S.years; S.gathered = yr.gathered || S.gathered;
        await load(S.year);
      }
    }).catch(() => { S.poll = setTimeout(pollGather, 3000); });
  }

  // ---------- a release that wasn't in a show, from its link ------------------------------------
  async function addByLink() {
    const input = el('yeAddUrl'), st = el('yeAddStatus'), btn = el('yeAddBtn');
    const url = input.value.trim();
    if (!url) { input.focus(); return; }
    st.textContent = 'looking it up…';
    btn.disabled = true;
    try {
      const j = await post('/ye/add', { year: S.year, url });
      if (!j.ok) { st.textContent = '✖ ' + (j.error || 'not found'); return; }
      const c = j.candidate;
      S.byKey.set(c.key, c);
      input.value = '';
      st.textContent = (j.existed ? 'already among the releases' : 'added') + `: ${c.artist} – ${c.title} (${TYPE_NAMES[c.type] || c.type}) — in the list`;
      decide(c.key, 'in');
    } catch (e) {
      st.textContent = '✖ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- names that are one artist ("same artist…") ----------------------------------------
  function toggleAliases() {
    S.aliasesOpen = !S.aliasesOpen;
    const box = el('yeAliasBox');
    box.hidden = !S.aliasesOpen;
    if (S.aliasesOpen) {
      el('yeAliasText').value = S.aliases.map((g) => g.join(' = ')).join('\n');
      el('yeAliasStatus').textContent = '';
      el('yeAliasText').focus();
    }
  }
  async function saveAliases() {
    const groups = el('yeAliasText').value.split('\n')
      .map((line) => line.split('=').map((n) => n.trim()).filter(Boolean))
      .filter((g) => g.length > 1);
    const j = await post('/ye/aliases', { groups });
    if (!j.ok) { el('yeAliasStatus').textContent = 'not saved: ' + (j.error || ''); return; }
    setAliases(j.groups);
    el('yeAliasText').value = S.aliases.map((g) => g.join(' = ')).join('\n');
    el('yeAliasStatus').textContent = `saved — ${S.aliases.length} artist${S.aliases.length === 1 ? '' : 's'} with more than one name`;
    renderPool();
  }

  // ---------- HTML for radioštudent -----------------------------------------------------------
  async function makeHtml() {
    const st = el('yeHtmlStatus');
    st.textContent = 'building…';
    clearTimeout(S.saveTimer);
    await post('/ye/save', { year: S.year, decisions: S.decisions, order: S.order, edits: S.edits });
    const j = await post('/ye/html', { year: S.year });
    if (!j.ok) { st.textContent = j.error || 'failed'; return; }
    el('yeOut').hidden = false;
    el('yeOutHtml').value = j.html;
    el('yeOutText').value = j.text;
    st.textContent = `${j.count} releases, alphabetical` + (j.short ? ` — ${j.short} short of ${S.listSize}` : '');
  }

  // ---------- events (delegated, set up once) -------------------------------------------------
  function wire() {
    const box = host();
    box.addEventListener('click', (e) => {
      const t = e.target;
      const play = t.closest('[data-play]');
      if (play && !t.closest('.ye-tracks')) return togglePlay(play.dataset.play, play.dataset.key);
      const act = t.closest('[data-act]');
      if (act) return decide(act.dataset.key, act.dataset.act);
      const ed = t.closest('[data-edit]');
      if (ed) { S.editing = S.editing === ed.dataset.edit ? null : ed.dataset.edit; return renderAll(); }
      const es = t.closest('[data-edit-save]');
      if (es) return saveEdit(es.dataset.editSave);
      const er = t.closest('[data-edit-reset]');
      if (er) return change(() => { delete S.edits[er.dataset.editReset]; S.editing = null; });
      const mv = t.closest('[data-move]');
      if (mv) return move(mv.dataset.key, mv.dataset.move);
      const view = t.closest('[data-view]');
      if (view) { S.view = view.dataset.view; savePrefs(); return renderAll(); }
      const type = t.closest('[data-type]');
      if (type) { S.types[type.dataset.type] = !S.types[type.dataset.type]; savePrefs(); return renderAll(); }
      const opt = t.closest('[data-opt]');
      if (opt) { S[opt.dataset.opt] = !S[opt.dataset.opt]; savePrefs(); return renderAll(); }
      if (t.id === 'yeAliasBtn' || t.id === 'yeAliasClose') return toggleAliases();
      if (t.id === 'yeAliasSave') return saveAliases();
      if (t.id === 'yeGather') return gather();
      if (t.id === 'yeUndo') return window.yearendUndo();
      if (t.id === 'yeRedo') return window.yearendRedo();
      if (t.id === 'yeHtmlBtn') return makeHtml();
      if (t.id === 'yeAddBtn') return addByLink();
      if (t.id === 'yeCopyHtml' || t.id === 'yeCopyText') {
        navigator.clipboard.writeText(el(t.id === 'yeCopyHtml' ? 'yeOutHtml' : 'yeOutText').value);
        const old = t.textContent; t.textContent = 'Copied!'; setTimeout(() => (t.textContent = old), 1200);
      }
    });
    box.addEventListener('change', (e) => {
      if (e.target.id === 'yeYear') load(Number(e.target.value));
      if (e.target.id === 'yeSort') { S.sort = e.target.value; savePrefs(); renderAll(); }
    });
    box.addEventListener('keydown', (e) => {
      if (e.target.id === 'yeAddUrl' && e.key === 'Enter') addByLink();
      const ed = e.target.closest && e.target.closest('.ye-editor');
      if (ed && e.key === 'Enter') saveEdit(ed.dataset.key);
      if (ed && e.key === 'Escape') { S.editing = null; renderAll(); }
    });
    let qTimer = null;
    box.addEventListener('input', (e) => {
      if (e.target.id !== 'yeSearch') return;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => { S.q = e.target.value; renderPool(); reopenPlayers(rememberPlaying()); }, 150);
    });
  }

  window.yearendTabActivated = async function () {
    if (S.loaded) return;
    S.loaded = true;
    host().innerHTML = '<div class="status">loading…</div>';
    wire();
    loadPrefs();
    try {
      const yr = await fetch('/ye/years').then((r) => r.json());
      S.years = yr.years || []; S.gathered = yr.gathered || [];
      host().innerHTML = '';
      await load(S.years[0] || new Date().getFullYear());
      pollGather(); // picks up a gather still running from before a reload
    } catch (e) {
      host().innerHTML = `<div class="errors">could not load: ${esc(e.message || e)}</div>`;
      S.loaded = false;
    }
  };
  // the page reopens the last tab before this script has loaded: start if it's this one
  if (el('panel-yearend') && !el('panel-yearend').hidden) window.yearendTabActivated();
})();
