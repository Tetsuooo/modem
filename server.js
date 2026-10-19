const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFileSync, spawn } = require('child_process');
const { undoesSomething } = require('./scripts/overrides-diff');
const app = express();

app.use(express.json({ limit: '4mb' }));

// Serve static assets from src
app.use(express.static(path.join(__dirname, 'src')));

// ---- dev-only: run the SoundCloud finder from the match-review page ----------
// find-sc-matches.js is slow (searches SoundCloud per Bandcamp track), so it runs
// as a background child; the page polls /find-matches-status for progress and,
// when done, regenerates the review page (gen-review.js) and reloads.
let findJob = null; // { running, done, error, log: [] }
function runNode(script, onClose) {
    const child = spawn(process.execPath, [path.join(__dirname, 'scripts', script)], { cwd: __dirname });
    const push = (buf) => {
        String(buf).split(/\r?\n/).forEach((l) => { if (l.trim()) findJob.log.push(l.trim()); });
        if (findJob.log.length > 300) findJob.log = findJob.log.slice(-300);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => { findJob.running = false; findJob.error = String(e.message || e); });
    child.on('close', onClose);
}
app.post('/run-find-matches', (req, res) => {
    if (findJob && findJob.running) return res.json({ ok: true, already: true });
    findJob = { running: true, done: false, error: null, log: ['starting soundcloud search…'] };
    runNode('find-sc-matches.js', (code) => {
        if (code !== 0) { findJob.running = false; findJob.error = 'find-sc-matches exited ' + code; return; }
        findJob.log.push('rebuilding review page…');
        runNode('gen-review.js', (c2) => {
            findJob.running = false;
            findJob.done = c2 === 0;
            if (c2 !== 0) findJob.error = 'gen-review exited ' + c2;
        });
    });
    res.json({ ok: true, started: true });
});
app.get('/find-matches-status', (req, res) => {
    if (!findJob) return res.json({ running: false, done: false, progress: '', log: [] });
    res.json({
        running: findJob.running, done: findJob.done, error: findJob.error,
        progress: findJob.log[findJob.log.length - 1] || '', log: findJob.log.slice(-10),
    });
});

// Dev-only: the match-review page posts its approvals here; we save them and
// run apply-sc-matches.js so decisions go live without any file shuffling.
app.post('/save-approvals', (req, res) => {
    try {
        fs.writeFileSync(path.join(__dirname, 'scripts', 'approvals.json'), JSON.stringify(req.body || {}, null, 2));
        const log = execFileSync('node', [path.join(__dirname, 'scripts', 'apply-sc-matches.js')], { encoding: 'utf8' });
        res.json({ ok: true, log });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message || e) });
    }
});

// Dev-only: viewport/device test harness (lives outside src/, never shipped to docs/)
app.get('/device-test.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'device-test.html'));
});

// Dev-only: bandcamp→soundcloud match review tool (lives in scripts/, never shipped)
app.get('/match-review', (req, res) => {
    res.sendFile(path.join(__dirname, 'scripts', 'sc-match-review.html'));
});

// Admin page (tag-merge etc.). On the live site this is a static page whose save
// goes to a serverless function; locally it posts to /save-overrides below.
const ADMIN_PW = process.env.ADMIN_PW || 'modem'; // dev default — set ADMIN_PW for anything real
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'admin.html'));
});
// Admin save (the /admin page and the inline editor on show pages): write the
// human-edit overrides, then apply them to the archive so the local preview
// shows the result. Same rule as the show builder's publish pipeline:
//   • new merges / new or changed edits → just apply-overrides.js on the
//     archive as it is, nothing else moves;
//   • something TAKEN BACK (a merge undone, an edit reset) → re-derive from
//     source first so the original spelling returns — scrape-modem.js
//     --reparse, bracketed by reparse-guard.js. A bare --reparse used to run on
//     EVERY save here, and it silently wiped what the radioštudent pages don't
//     carry: the draft-sourced tags of modem-248/249, backfilled audio, the
//     segment-marker fixes (see scripts/reparse-guard.js).
// For the actual site, the show builder's Tags tab + publish is the way; this
// stays for previewing locally.
app.post('/save-overrides', (req, res) => {
    try {
        if (!req.body || req.body.password !== ADMIN_PW) return res.status(401).json({ ok: false, error: 'wrong password' });
        const overrides = req.body.overrides || { tagMerges: {} };
        const file = path.join(__dirname, 'src', 'assets', 'overrides.json');
        let previous = {};
        try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first save */ }
        const rederive = undoesSomething(previous, overrides);
        // tracklist start-time fixes are only edited in the show builder — keep them
        if (previous.timeEdits) overrides.timeEdits = previous.timeEdits;
        fs.writeFileSync(file, JSON.stringify(overrides, null, 2));
        const run = (script, args = []) => execFileSync(process.execPath, [path.join(__dirname, 'scripts', script), ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
        if (rederive) {
            run('reparse-guard.js', ['--snapshot']);
            run('scrape-modem.js', ['--reparse']);
            run('reparse-guard.js', ['--restore']);
            run('build-track-index.js');
            run('apply-sc-matches.js');
        }
        const log = run('apply-overrides.js');
        res.json({ ok: true, log, rederived: rederive });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message || e) });
    }
});

// For all routes, serve index.html to enable client-side routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'index.html'));
});

const port = 8085;
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
