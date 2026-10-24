// "Health" tab — do the outside services the builder and the website lean on still work?
// One row per check (show-builder/health.js runs them, each in its own process); a fix
// button where the fix is simple (new SoundCloud key, update yt-dlp, Sync + latest version,
// restart); "copy details" for anything that needs a code fix.
//
// Runs everything by itself once a day when the builder opens, and badges the tab button
// when something needs attention — so a SoundCloud/Bandcamp change shows up on an
// ordinary day, not on show night.
//
// Loaded after index.html's inline script and shares its globals (el, esc, escAttr).
(function () {
  'use strict';

  const ICON = { ok: '✓', warn: '!', fail: '✗', skip: '–', running: '…' };
  const RERUN_AFTER_FIX = {
    'sc-key': ['sc-access', 'sc-scan', 'sc-preview', 'sc-search'],
    ytdlp: ['downloads'],
    browser: ['sc-player'],
    update: ['version'],
  };
  const DAY = 24 * 3600 * 1000;
  const S = { checks: [], results: {}, lastRunAt: null, running: new Set(), fixing: null, logs: {}, canRestart: false, open: new Set() };
  const host = () => el('healthTab');
  const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then((r) => r.json());

  function ago(iso) {
    if (!iso) return 'never';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    if (s < 5400) return Math.round(s / 60) + ' min ago';
    if (s < 129600) return Math.round(s / 3600) + ' h ago';
    return Math.round(s / 86400) + ' days ago';
  }

  // ---------- the tab button's badge ---------------------------------------------------
  function updateBadge() {
    const badge = el('healthBadge');
    if (!badge) return;
    const rs = Object.values(S.results);
    const bad = rs.filter((r) => r.status === 'fail').length;
    const todo = rs.filter((r) => r.status === 'warn').length;
    badge.hidden = !(bad || todo);
    badge.textContent = bad ? `${bad} ✗` : `${todo} !`;
    badge.classList.toggle('hl-badge-fail', !!bad);
    badge.classList.toggle('hl-badge-warn', !bad && !!todo);
    badge.title = bad ? 'something the builder needs is broken — see Health' : 'something to update — see Health';
  }

  // ---------- running ------------------------------------------------------------------
  // `run`: when the full run this check belongs to began (see /health/check)
  async function runCheck(id, run) {
    S.running.add(id);
    render();
    try {
      const j = await post('/health/check', { id, run: run || null });
      if (j.ok) S.results[id] = j.result;
    } catch (e) {
      S.results[id] = { status: 'fail', summary: "Couldn't reach the builder's server.", detail: String(e) };
    }
    S.running.delete(id);
    render();
    updateBadge();
  }

  async function runAll() {
    const run = new Date().toISOString();
    const queue = S.checks.map((c) => c.id);
    // four at a time: quick, but gentle on SoundCloud and Bandcamp
    await Promise.all([0, 1, 2, 3].map(async () => {
      while (queue.length) await runCheck(queue.shift(), run);
    }));
    S.lastRunAt = run;
    render();
  }

  async function runFix(checkId, fixId) {
    if (fixId === 'restart') return restart();
    S.fixing = checkId;
    S.logs[checkId] = 'working…';
    render();
    let j;
    try {
      j = await post('/health/fix', { id: fixId });
    } catch (e) {
      j = { ok: false, log: String(e) };
    }
    S.logs[checkId] = (j.ok ? '' : 'Didn’t work:\n') + (j.log || '(no output)');
    S.fixing = null;
    render();
    for (const id of RERUN_AFTER_FIX[fixId] || [checkId]) await runCheck(id);
    if (j.restartNeeded) {
      S.results.version = { status: 'warn', summary: 'Got the latest version — restart the builder to use it.', detail: '', fix: 'restart', fixLabel: 'Restart the builder', at: new Date().toISOString() };
      render();
      updateBadge();
    }
  }

  // start.bat closes this server and starts a new one; wait for it, then reload the page.
  // `box` = where to say how it's going (the Health tab's note, or the page's restart banner).
  async function restart(box) {
    if (!(box instanceof Element)) box = el('hlRestartNote'); // a click passes its event
    let before = null;
    try { before = (await (await fetch('/health/ping')).json()).startedAt; } catch (e) { /* ignore */ }
    // a server too old to restart itself answers with an error page, not JSON
    const j = await post('/health/restart').catch(() => ({ ok: false, log: "This builder is too old to restart itself — close its window and start it again with start.bat." }));
    if (!j.ok) { if (box) box.textContent = j.log || 'Restart it with start.bat.'; return; }
    if (box) box.textContent = 'Restarting the builder… the page reloads by itself.';
    const t0 = Date.now();
    const tick = async () => {
      try {
        const p = await (await fetch('/health/ping', { cache: 'no-store' })).json();
        if (p.startedAt && p.startedAt !== before) return location.reload();
      } catch (e) { /* the old one is gone, the new one isn't up yet */ }
      if (Date.now() - t0 > 45000) { if (box) box.textContent = "The builder didn't come back by itself — start it with start.bat."; return; }
      setTimeout(tick, 1000);
    };
    setTimeout(tick, 1500);
  }

  function report() {
    const lines = [`modem show builder — health check (${new Date().toLocaleString()}, ${navigator.platform})`, ''];
    for (const c of S.checks) {
      const r = S.results[c.id];
      if (!r) { lines.push(`  ${c.name}: not checked`); continue; }
      lines.push(`${ICON[r.status] || '?'} ${c.name}: ${r.summary}`);
      if (r.detail && r.status !== 'ok') lines.push(r.detail.split('\n').map((l) => '    ' + l).join('\n'));
    }
    return lines.join('\n');
  }
  async function copy(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      const was = btn.textContent;
      btn.textContent = 'copied ✓';
      setTimeout(() => { btn.textContent = was; }, 1500);
    } catch (e) {
      window.prompt('Copy this:', text);
    }
  }

  // ---------- render ---------------------------------------------------------------------
  function render() {
    const box = host();
    if (!box || !S.checks.length) return;
    const busy = S.running.size > 0;
    const head = `<div class="hl-head">
        <button class="primary" id="hlRunAll" ${busy ? 'disabled' : ''}>${busy ? 'Checking…' : 'Run all checks'}</button>
        ${S.canRestart ? '<button id="hlRestart" title="close the builder and start it again — e.g. after getting a new version">Restart the builder</button>' : ''}
        <button id="hlCopyAll" title="everything below as text, to paste to whoever fixes the code">Copy report</button>
        <span class="status">last checked ${esc(ago(S.lastRunAt))} · runs by itself once a day</span>
        <span id="hlRestartNote" class="status"></span>
      </div>
      <p class="status hl-intro">Checks that SoundCloud, Bandcamp, yt-dlp and the website still work the way the builder expects. They change things without warning; this finds out on an ordinary day. A button next to a problem fixes it when the fix is simple — otherwise “copy details” and pass it on.</p>`;
    const rows = S.checks.map((c) => {
      const r = S.results[c.id];
      const running = S.running.has(c.id);
      const st = running ? 'running' : (r ? r.status : 'none');
      const open = S.open.has(c.id);
      const fixing = S.fixing === c.id;
      return `<div class="hl-row hl-${st}" data-id="${escAttr(c.id)}">
        <span class="hl-icon">${running ? ICON.running : (r ? ICON[r.status] : '·')}</span>
        <div class="hl-main">
          <div class="hl-line"><span class="hl-name">${esc(c.name)}</span>
            <span class="hl-summary">${running ? 'checking…' : (r ? esc(r.summary) : 'not checked yet')}</span></div>
          <div class="hl-what">${esc(c.what)}${r && r.at && !running ? ` <span class="hl-when">· ${esc(ago(r.at))}</span>` : ''}</div>
          <div class="hl-actions">
            ${r && r.fix && !running ? `<button class="accent pill-btn hl-fix" data-fix="${escAttr(r.fix)}" ${fixing ? 'disabled' : ''}>${fixing ? 'working…' : esc(r.fixLabel || 'Fix')}</button>` : ''}
            ${r && r.detail && !running ? `<button class="pill-btn hl-more">${open ? 'hide details' : 'details'}</button>` : ''}
            ${r && (r.status === 'fail' || r.status === 'warn') && !running ? '<button class="pill-btn hl-copy">copy details</button>' : ''}
            <button class="pill-btn hl-again" ${running ? 'disabled' : ''}>check again</button>
          </div>
          ${open && r && r.detail ? `<pre class="hl-detail">${esc(r.detail)}</pre>` : ''}
          ${S.logs[c.id] ? `<pre class="hl-detail hl-log">${esc(S.logs[c.id])}</pre>` : ''}
        </div>
      </div>`;
    }).join('');
    box.innerHTML = head + `<div class="hl-list">${rows}</div>`;
    wire(box);
  }

  function wire(box) {
    const b = (id) => box.querySelector('#' + id);
    b('hlRunAll').addEventListener('click', () => { S.logs = {}; runAll(); });
    if (b('hlRestart')) b('hlRestart').addEventListener('click', restart);
    b('hlCopyAll').addEventListener('click', (e) => copy(report(), e.currentTarget));
    box.querySelectorAll('.hl-row').forEach((row) => {
      const id = row.dataset.id;
      const r = S.results[id];
      const on = (sel, fn) => { const x = row.querySelector(sel); if (x) x.addEventListener('click', fn); };
      on('.hl-fix', (e) => runFix(id, e.currentTarget.dataset.fix));
      on('.hl-more', () => { if (S.open.has(id)) S.open.delete(id); else S.open.add(id); render(); });
      on('.hl-copy', (e) => {
        const c = S.checks.find((x) => x.id === id);
        copy(`${c.name}: ${r.summary}\n${r.detail || ''}`.trim(), e.currentTarget);
      });
      on('.hl-again', () => { delete S.logs[id]; runCheck(id); });
    });
  }

  // ---------- start ------------------------------------------------------------------------
  async function load() {
    try {
      const j = await (await fetch('/health/state')).json();
      if (!j.ok) return;
      S.checks = j.checks;
      S.results = j.results || {};
      S.lastRunAt = j.lastRunAt;
      S.canRestart = !!j.canRestart;
      // a check that says "restart" is stale once this server is the newer one
      if (S.results.version && S.results.version.fix === 'restart' && S.results.version.at < j.startedAt) delete S.results.version;
    } catch (e) {
      return; // an older server without /health: nothing to show
    }
    updateBadge();
    render();
    if (!S.lastRunAt || Date.now() - new Date(S.lastRunAt).getTime() > DAY) runAll();
  }

  window.healthTabActivated = () => render();
  window.restartBuilder = restart; // index.html's "restart the builder" banner
  load();
})();
