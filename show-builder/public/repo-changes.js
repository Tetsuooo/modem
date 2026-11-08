// What a publish stopped on: uncommitted changes it didn't make, listed with "show", "commit"
// and "put back" per file, grouped by kind (server: repo-changes.js). Once every file is
// sorted out, the publish carries on by itself. Used by Publish & Edit's "Run publish
// pipeline" and "Put it on the site", and Edit site's "Publish site edits" (2026-11-08).
(function () {
  const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const GROUPS = [
    ['code', 'Builder code', 'Changed on this computer (by Claude, or by hand) and never committed. Usually you want to keep it: commit.'],
    ['other', 'Website or repo files', 'Commit only if the change is meant to be on the site: it goes live with the next push. Otherwise put it back.'],
    ['output', 'Made by a publish run', 'Left behind by a run that didn’t finish. Put it back; the publish makes it again.'],
  ];
  const AFTER_COMMIT = 'it goes to GitHub with the next Confirm & push or Sync';

  async function post(url, body) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      return { ok: false, error: 'could not reach the show builder: ' + (e.message || e) };
    }
    try { return await r.json(); } catch (e) {
      return { ok: false, error: r.status === 404 ? 'this builder is older than the page: restart the builder, then try again' : `HTTP ${r.status}` };
    }
  }

  function colourDiff(text) {
    return text.split('\n').map((l) => {
      const cls = /^(\+\+\+|---) /.test(l) ? 'rc-d-file' : l[0] === '+' ? 'rc-d-add' : l[0] === '-' ? 'rc-d-del' : l.startsWith('@@') ? 'rc-d-hunk' : '';
      return cls ? `<span class="${cls}">${h(l)}</span>` : h(l);
    }).join('\n');
  }

  // box: where to draw it. result: the refusal ({ error, dirtyFiles, changes }). retry: runs
  // the same publish again. Returns false when there's no list to draw (an older server, or
  // a different refusal): the caller then shows its plain error as before.
  window.showRepoChanges = function (box, result, retry) {
    if (!result || !Array.isArray(result.changes) || !result.changes.length) return false;
    let changes = result.changes.slice();
    const done = []; // what was done, shown at the top
    const open = {}; // file → its diff, while shown
    const errs = {}; // file → what went wrong
    let busy = false;

    const wrap = document.createElement('div');
    wrap.className = 'rc-panel';
    box.innerHTML = '';
    box.appendChild(wrap);

    function row(c) {
      const counts = c.added == null ? '' : ` · <span class="rc-d-add">+${c.added}</span> <span class="rc-d-del">−${c.removed}</span>`;
      const f = h(c.file);
      return `<div class="rc-row">
        <div class="rc-line">
          <code class="rc-file">${f}</code>
          <span class="rc-meta">${h(c.status)}${counts}</span>
          <span class="rc-btns">
            <button class="pill-btn" data-rc="show" data-file="${f}" ${busy ? 'disabled' : ''}>${open[c.file] != null ? 'hide' : 'show'}</button>
            ${c.kind === 'output' ? '' : `<button class="pill-btn${c.kind === 'code' ? ' accent' : ''}" data-rc="commit" data-file="${f}" ${busy ? 'disabled' : ''}>commit</button>`}
            <button class="pill-btn${c.kind === 'output' ? ' accent' : ''}" data-rc="put-back" data-file="${f}" ${busy ? 'disabled' : ''}>put back</button>
          </span>
        </div>
        ${c.note ? `<div class="rc-note">${h(c.note)}</div>` : ''}
        ${errs[c.file] ? `<div class="rc-err">${h(errs[c.file])}</div>` : ''}
        ${open[c.file] != null ? `<pre class="rc-diff">${open[c.file] === '' ? 'loading…' : colourDiff(open[c.file])}</pre>` : ''}
      </div>`;
    }

    function draw() {
      const code = changes.filter((c) => c.kind === 'code');
      wrap.innerHTML = `
        <div class="rc-head">${changes.length
          ? 'It stopped: these files changed on this computer, but not by a publish, so it won’t build on top of them. Sort out each one and it carries on by itself.'
          : 'All sorted. Carrying on…'}</div>
        ${done.map((d) => `<div class="rc-done">✓ ${h(d)}</div>`).join('')}
        ${GROUPS.map(([kind, title, hint]) => {
          const rows = changes.filter((c) => c.kind === kind);
          if (!rows.length) return '';
          return `<div class="rc-group"><div class="rc-group-title">${title}</div><div class="rc-group-hint">${hint}</div>${rows.map(row).join('')}</div>`;
        }).join('')}
        ${code.length > 1 ? `<div class="rc-all"><button class="accent" data-rc="commit-all" ${busy ? 'disabled' : ''}>Commit all ${code.length} code files</button></div>` : ''}
        ${errs['*'] ? `<div class="rc-err">${h(errs['*'])}</div>` : ''}`;
    }

    // the files are sorted out: off the list; when it's empty, run the publish again
    function handled(files, what) {
      changes = changes.filter((c) => !files.includes(c.file));
      for (const f of files) { delete open[f]; delete errs[f]; }
      done.push(what);
      draw();
      if (!changes.length && retry) setTimeout(retry, 400);
    }

    async function act(kind, files) {
      const one = files.length === 1 ? files[0] : null;
      const c = one && changes.find((x) => x.file === one);
      if (kind === 'commit') {
        const site = files.some((f) => (changes.find((x) => x.file === f) || {}).kind !== 'code');
        const list = files.join('\n');
        if (!confirm(`Commit ${one || `these ${files.length} files`}?\n\n${one ? '' : list + '\n\n'}` + (site
          ? 'Part of the website or the repo: the change goes live with the next push. Only if it is meant to be there.'
          : `Saved in git on this computer; ${AFTER_COMMIT}.`))) return;
      } else if (!confirm(`Put ${one || `these ${files.length} files`} back to the last committed version?\n\n` +
        `${c && c.status.startsWith('new') ? 'It’s new, so it goes away. ' : 'The change goes. '}A copy is kept in show-builder/data/.cache/put-back/, in case you need it.`)) return;
      busy = true;
      delete errs['*'];
      for (const f of files) delete errs[f];
      draw();
      const j = await post(kind === 'commit' ? '/repo-changes/commit' : '/repo-changes/put-back', { files });
      busy = false;
      if (!j.ok) {
        errs[one || '*'] = j.error || 'that didn’t work';
        return draw();
      }
      const names = one || `${files.length} files`;
      handled(files, kind === 'commit' ? `committed ${names} (${j.commit}): ${AFTER_COMMIT}` : `put back ${names} (a copy: ${j.backup})`);
    }

    async function toggleDiff(file) {
      if (open[file] != null) { delete open[file]; return draw(); }
      open[file] = '';
      draw();
      let j;
      try { j = await (await fetch('/repo-changes/diff?file=' + encodeURIComponent(file))).json(); } catch (e) { j = { ok: false, error: 'this builder is older than the page: restart the builder' }; }
      if (open[file] == null) return; // hidden meanwhile
      if (j.ok) open[file] = j.diff; else { delete open[file]; errs[file] = j.error; }
      draw();
    }

    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-rc]');
      if (!b || busy) return;
      const file = b.dataset.file;
      if (b.dataset.rc === 'show') toggleDiff(file);
      else if (b.dataset.rc === 'commit') act('commit', [file]);
      else if (b.dataset.rc === 'put-back') act('put-back', [file]);
      else if (b.dataset.rc === 'commit-all') act('commit', changes.filter((c) => c.kind === 'code').map((c) => c.file));
    });
    draw();
    return true;
  };
})();
