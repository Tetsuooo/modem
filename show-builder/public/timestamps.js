// "Tracklist" tab — set the live tracklist's start times by hand while listening to
// the show. For tracks the audio matching couldn't place ("~", estimated) or placed
// wrong; shows published from the Mix tab are exact already.
//
// Pick a show (most estimated first), play it here (the show's own SoundCloud upload,
// the same audio the site plays), and for a track either type its time, press
// "set to now" at the moment it starts, nudge it, or mark it "not played". Markers on
// the timeline: white = matched, orange = estimated, green = set by hand.
//
// Saving writes overrides.json → timeEdits (show-builder/time-tools.js); "Publish site
// edits" in the Edit site tab puts them online (scripts/tracklists/apply-timestamp-edits.js).
// Loaded after index.html's inline script and shares its globals (el, esc, escAttr).
(function () {
  'use strict';

  const S = {
    shows: [], sort: 'estimated', slug: null, show: null,
    edits: {}, saved: '{}', // pending fixes (rowId → seconds | false) and the saved version
    widget: null, playing: false, pos: 0, dur: 0, pendingSeek: null, loadedFor: null,
  };
  const host = () => el('timesTab');
  const fmt = (s) => {
    if (s == null || !Number.isFinite(s)) return '–:––';
    const m = Math.floor(s / 60), r = s - m * 60;
    return m + ':' + r.toFixed(1).padStart(4, '0');
  };
  // "12:34.5", "12:34", "754" (seconds) → seconds
  const parseT = (str) => {
    const t = String(str || '').trim();
    if (!t) return null;
    const m = t.match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/);
    if (!m) return null;
    return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2].replace(',', '.'));
  };
  const dirty = () => JSON.stringify(S.edits) !== S.saved;
  const effective = (r) => {
    const e = S.edits[r.id];
    if (e === false) return { t: r.auto, hidden: true, fixed: false };
    if (typeof e === 'number') return { t: e, hidden: false, fixed: true };
    return { t: r.auto, hidden: false, fixed: false };
  };

  // ---------- SoundCloud player (the show's own upload) ----------
  function scApi() {
    if (window.SC && SC.Widget) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://w.soundcloud.com/player/api.js';
      s.onload = resolve; s.onerror = () => reject(new Error('could not load the SoundCloud player'));
      document.head.appendChild(s);
    });
  }
  async function loadPlayer() {
    const sc = S.show && S.show.soundcloud;
    const wrapEl = el('ttIframeWrap');
    if (!sc || !sc.api) { el('ttPlayerStatus').textContent = 'this show has no SoundCloud upload'; return; }
    if (S.loadedFor === S.slug && S.widget) return;
    await scApi();
    S.playing = false; S.pos = 0; S.dur = 0; S.pendingSeek = null;
    wrapEl.innerHTML = '<iframe id="ttIframe" allow="autoplay" style="position:absolute;left:-9999px;width:320px;height:160px;border:0" src="https://w.soundcloud.com/player/?url=' +
      encodeURIComponent(sc.api) + '&auto_play=false&visual=false&show_comments=false&buying=false&sharing=false&download=false&hide_related=true"></iframe>';
    const w = SC.Widget(el('ttIframe'));
    S.widget = w; S.loadedFor = S.slug;
    el('ttPlayerStatus').textContent = 'loading the show…';
    w.bind(SC.Widget.Events.READY, () => {
      el('ttPlayerStatus').textContent = '';
      w.getDuration((d) => { S.dur = d / 1000; drawTimeline(); updateClock(); });
    });
    w.bind(SC.Widget.Events.PLAY, () => {
      S.playing = true; el('ttPlay').textContent = '❚❚ pause';
      if (S.pendingSeek != null) { w.seekTo(S.pendingSeek * 1000); S.pendingSeek = null; }
    });
    w.bind(SC.Widget.Events.PAUSE, () => { S.playing = false; el('ttPlay').textContent = '▶ play'; });
    w.bind(SC.Widget.Events.FINISH, () => { S.playing = false; el('ttPlay').textContent = '▶ play'; });
    w.bind(SC.Widget.Events.PLAY_PROGRESS, (e) => { S.pos = e.currentPosition / 1000; updateClock(); });
  }
  function seek(sec, play) {
    if (!S.widget) return;
    sec = Math.max(0, sec);
    S.pos = sec; updateClock();
    if (S.playing) S.widget.seekTo(sec * 1000);
    else if (play) { S.pendingSeek = sec; S.widget.play(); }
    else { S.pendingSeek = sec; } // applied when play is pressed
  }
  function togglePlay() { if (S.widget) { if (S.playing) S.widget.pause(); else S.widget.play(); } }

  // ---------- rendering ----------
  const optionsHtml = () => sortedShows().map((s) =>
    `<option value="${escAttr(s.slug)}"${s.slug === S.slug ? ' selected' : ''}>${esc(showLabel(s))}</option>`).join('');
  function render() {
    const opts = optionsHtml();
    host().innerHTML = `
      <p class="status">Set where tracks start, while listening to the show. <b>~</b> = estimated by the matching (no audio found / no match) — those are the ones to check.
        Saved fixes go online with <b>Publish site edits</b> (Edit site tab), like tag edits.</p>
      <div class="tt-bar">
        <select id="ttShow" class="tg-input">${opts}</select>
        <label class="status"><input type="radio" name="ttSort" value="estimated"${S.sort === 'estimated' ? ' checked' : ''}> most estimated first</label>
        <label class="status"><input type="radio" name="ttSort" value="number"${S.sort === 'number' ? ' checked' : ''}> by show number</label>
      </div>
      <div id="ttShowBody">${S.show ? '' : '<div class="empty">pick a show</div>'}</div>`;
    el('ttShow').onchange = (e) => openShow(e.target.value);
    // re-sort the picker only (re-rendering the show would reload the player)
    host().querySelectorAll('input[name="ttSort"]').forEach((r) => { r.onchange = () => { S.sort = r.value; el('ttShow').innerHTML = optionsHtml(); }; });
    if (S.show) renderShow();
  }
  function sortedShows() {
    const a = S.shows.slice();
    if (S.sort === 'estimated') a.sort((x, y) => (y.estimated - y.edited) - (x.estimated - x.edited) || (y.number || 0) - (x.number || 0));
    return a;
  }
  function showLabel(s) {
    return `modem ${s.number || s.slug} · ${s.date} — ${s.estimated ? s.estimated + ' of ' + s.tracks + ' estimated' : 'all ' + s.tracks + ' matched'}` +
      (s.edited ? ` · ${s.edited} fixed by hand` : '') + (s.source === 'builder' ? ' · from the Mix tab' : '');
  }

  function renderShow() {
    const body = el('ttShowBody');
    const n = S.show.rows.length, est = S.show.rows.filter((r) => r.approx).length;
    body.innerHTML = `
      <div class="tt-player">
        <button id="ttPlay" class="primary">${S.playing ? '❚❚ pause' : '▶ play'}</button>
        <button id="ttBack" title="5 s back">−5 s</button>
        <button id="ttFwd" title="5 s forward">+5 s</button>
        <span id="ttClock" class="tt-clock">0:00.0 / –:––</span>
        <span id="ttPlayerStatus" class="status"></span>
        <span class="grow"></span>
        <span id="ttDirty" class="status"></span>
        <button id="ttSave" class="accent">Save fixes</button>
      </div>
      <div id="ttTimeline" class="tt-timeline" title="click to jump there"><div id="ttHead" class="tt-head"></div></div>
      <p class="status">${n} tracks · ${est} estimated · keys: <b>space</b> play/pause. A row's <b>now</b> button sets its start to where the show is playing.</p>
      <div id="ttRows" class="tt-rows"></div>
      <div id="ttIframeWrap"></div>`;
    el('ttPlay').onclick = togglePlay;
    el('ttBack').onclick = () => seek(S.pos - 5, S.playing);
    el('ttFwd').onclick = () => seek(S.pos + 5, S.playing);
    el('ttSave').onclick = save;
    el('ttTimeline').onclick = (e) => {
      if (!S.dur) return;
      const r = el('ttTimeline').getBoundingClientRect();
      seek(((e.clientX - r.left) / r.width) * S.dur, true);
    };
    renderRows();
    S.loadedFor = null; S.widget = null; // a fresh iframe for this show
    loadPlayer().catch((e) => { el('ttPlayerStatus').textContent = String(e.message || e); });
  }

  function renderRows() {
    const rows = S.show.rows.map((r) => ({ r, e: effective(r) })).sort((a, b) => a.e.t - b.e.t);
    el('ttRows').innerHTML = rows.map(({ r, e }) => {
      const badge = e.hidden ? '<span class="sc-badge none">not played</span>'
        : e.fixed ? '<span class="sc-badge ok">set by hand</span>'
        : r.approx ? '<span class="sc-badge todo">~ estimated</span>' : '<span class="sc-badge auto">matched</span>';
      const edited = r.id in S.edits;
      return `<div class="tt-row${e.hidden ? ' hidden' : ''}${r.approx && !edited ? ' est' : ''}" data-id="${escAttr(r.id)}">
        <input class="tg-input tt-time" value="${escAttr(fmt(e.t))}" title="start time (m:ss.s) — Enter to set">
        ${badge}
        ${r.art ? `<img src="${escAttr(r.art)}" alt="">` : '<span class="tt-noart"></span>'}
        <span class="tt-name"><span class="tt-artist">${esc(r.artist)}</span> <b>${esc(r.title)}</b></span>
        <button data-act="play" title="play from just before this start">▶</button>
        <button data-act="now" title="set this start to where the show is now">now</button>
        <button data-act="minus" title="1 s earlier">−1</button>
        <button data-act="plus" title="1 s later">+1</button>
        <button data-act="hide" title="this track wasn't played in the show — hide it on the site">${e.hidden ? 'played' : 'not played'}</button>
        ${edited ? `<button data-act="reset" title="back to ${r.approx ? 'the estimate' : 'the matched time'} (${escAttr(fmt(r.auto))})">↺</button>` : ''}
      </div>`;
    }).join('');
    el('ttRows').querySelectorAll('.tt-row').forEach((rowEl) => {
      const r = S.show.rows.find((x) => x.id === rowEl.dataset.id);
      const set = (v) => { S.edits[r.id] = v; changed(); };
      const timeIn = rowEl.querySelector('.tt-time');
      timeIn.onkeydown = (e) => { if (e.key === 'Enter') { const t = parseT(timeIn.value); if (t != null) set(t); else timeIn.classList.add('bad'); } };
      timeIn.onblur = () => { const t = parseT(timeIn.value); if (t != null && Math.abs(t - effective(r).t) > 0.05) set(t); };
      rowEl.querySelectorAll('button').forEach((b) => {
        b.onclick = () => {
          const e = effective(r);
          if (b.dataset.act === 'play') seek(e.t - 1, true);
          else if (b.dataset.act === 'now') set(Math.round(S.pos * 10) / 10);
          else if (b.dataset.act === 'minus') set(Math.max(0, Math.round((e.t - 1) * 10) / 10));
          else if (b.dataset.act === 'plus') set(Math.round((e.t + 1) * 10) / 10);
          else if (b.dataset.act === 'hide') { if (e.hidden) delete S.edits[r.id]; else S.edits[r.id] = false; changed(); }
          else if (b.dataset.act === 'reset') { delete S.edits[r.id]; changed(); }
        };
      });
    });
    drawTimeline(); updateClock(); updateDirty();
  }
  function changed() { renderRows(); }

  function drawTimeline() {
    const tl = el('ttTimeline');
    if (!tl || !S.show) return;
    tl.querySelectorAll('.tt-mark').forEach((m) => m.remove());
    const dur = S.dur || Math.max(60, ...S.show.rows.map((r) => effective(r).t + 60));
    for (const r of S.show.rows) {
      const e = effective(r);
      if (e.hidden) continue;
      const m = document.createElement('div');
      m.className = 'tt-mark ' + (e.fixed ? 'fixed' : r.approx ? 'est' : 'ok');
      m.style.left = (100 * e.t / dur) + '%';
      m.title = fmt(e.t) + '  ' + r.artist + ' — ' + r.title;
      tl.appendChild(m);
    }
  }
  function updateClock() {
    const c = el('ttClock'); if (!c) return;
    c.textContent = fmt(S.pos) + ' / ' + fmt(S.dur || null);
    const head = el('ttHead');
    if (head && S.dur) head.style.left = (100 * S.pos / S.dur) + '%';
    // the row being played right now
    const rowsEl = el('ttRows'); if (!rowsEl) return;
    let cur = null;
    for (const r of S.show.rows) { const e = effective(r); if (!e.hidden && e.t <= S.pos + 0.05 && (!cur || e.t >= cur.t)) cur = { id: r.id, t: e.t }; }
    rowsEl.querySelectorAll('.tt-row').forEach((x) => x.classList.toggle('current', !!cur && x.dataset.id === cur.id));
  }
  function updateDirty() {
    const n = Object.keys(S.edits).length;
    el('ttDirty').textContent = dirty() ? 'unsaved changes' : (n ? n + ' fix' + (n === 1 ? '' : 'es') + ' saved' : '');
    el('ttSave').disabled = !dirty();
  }

  // ---------- data ----------
  async function loadShows() {
    const r = await (await fetch('/times/shows')).json();
    if (!r.ok) throw new Error(r.error);
    S.shows = r.shows;
  }
  async function openShow(slug) {
    if (dirty() && !confirm('This show has unsaved fixes. Leave them?')) { el('ttShow').value = S.slug; return; }
    if (S.widget) { try { S.widget.pause(); } catch (e) { /* gone */ } }
    S.slug = slug; S.show = null; S.edits = {}; S.saved = '{}'; S.playing = false;
    if (el('ttShow')) el('ttShow').value = slug;
    el('ttShowBody').innerHTML = '<div class="empty">loading…</div>';
    try {
      const r = await (await fetch('/times/show?slug=' + encodeURIComponent(slug))).json();
      if (!r.ok) throw new Error(r.error);
      S.show = r; S.edits = { ...r.edits }; S.saved = JSON.stringify(S.edits);
      try { localStorage.setItem('sb-times-show', slug); } catch (e) { /* ignore */ }
      renderShow();
    } catch (e) {
      el('ttShowBody').innerHTML = `<div class="errors">could not load ${esc(slug)}: ${esc(e.message || e)}</div>`;
    }
  }
  async function save() {
    el('ttSave').disabled = true;
    try {
      const r = await (await fetch('/times/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ slug: S.slug, edits: S.edits }) })).json();
      if (!r.ok) throw new Error(r.error);
      S.saved = JSON.stringify(S.edits);
      el('ttDirty').textContent = 'saved — Publish site edits (Edit site tab) to put it online';
      await loadShows();
      const opt = el('ttShow').querySelector(`option[value="${CSS.escape(S.slug)}"]`);
      const s = S.shows.find((x) => x.slug === S.slug);
      if (opt && s) opt.textContent = showLabel(s);
      updateDirty();
      el('ttDirty').textContent = 'saved — Publish site edits (Edit site tab) to put it online';
    } catch (e) {
      el('ttDirty').textContent = 'could not save: ' + (e.message || e);
      el('ttSave').disabled = false;
    }
  }

  document.addEventListener('keydown', (e) => {
    if (el('panel-times') && el('panel-times').hidden) return;
    if (e.code !== 'Space' || /input|textarea|select/i.test(e.target.tagName)) return;
    e.preventDefault(); togglePlay();
  });
  window.addEventListener('beforeunload', (e) => { if (S.show && dirty()) { e.preventDefault(); e.returnValue = ''; } });

  let started = false;
  window.timesTabActivated = async function () {
    if (started) return;
    started = true;
    host().innerHTML = '<div class="empty">loading the tracklists…</div>';
    try {
      await loadShows();
      let slug = null;
      try { slug = localStorage.getItem('sb-times-show'); } catch (e) { /* ignore */ }
      if (!S.shows.some((s) => s.slug === slug)) slug = sortedShows()[0] && sortedShows()[0].slug;
      render();
      if (slug) openShow(slug);
    } catch (e) {
      started = false;
      host().innerHTML = `<div class="errors">could not load the tracklists: ${esc(e.message || e)}</div>`;
    }
  };
})();
