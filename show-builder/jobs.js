// A tiny background-job runner for the "site tools" routes — today only the
// SoundCloud links tab's "find new matches" (find-sc-matches.js, minutes long).
// Jobs go through ONE shared queue and run strictly one at a time, so anything
// added later that writes the same files can't overlap it.
//
// Same idea as the /download and /publish-run jobs in server.js (spawn child
// processes, collect their output, let the page poll for progress), just
// reusable and queued. Those two keep their own inline copies on purpose —
// they're older, working code, and the publish pipeline guards its own state.
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const LOG_LIMIT = 300;

const queue = [];   // [{ job, steps }] waiting their turn
const latest = {};  // name -> most recent job object with that name
let running = null; // the queue entry currently executing

function runSteps(entry, onFinish) {
  const { job, steps } = entry;
  const push = (buf) => {
    String(buf).split(/\r?\n/).forEach((l) => { if (l.trim()) job.log.push(l.trim()); });
    if (job.log.length > LOG_LIMIT) job.log = job.log.slice(-LOG_LIMIT);
  };
  (function next(i) {
    if (i >= steps.length) { job.state = 'done'; return onFinish(); }
    const [args, label] = steps[i];
    job.step = label;
    job.log.push('→ ' + label);
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT });
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', (e) => { job.state = 'error'; job.error = String(e.message || e); onFinish(); });
    child.on('close', (code) => {
      if (code !== 0) { job.state = 'error'; job.error = label + ' exited ' + code; return onFinish(); }
      next(i + 1);
    });
  })(0);
}

function pump() {
  if (running || !queue.length) return;
  running = queue.shift();
  running.job.state = 'running';
  runSteps(running, () => { running = null; pump(); });
}

// steps: [[nodeArgs[], 'label'], ...] — each runs as `node <nodeArgs>` in the
// repo root. If a job with this name is already WAITING (not yet started), it
// will pick up whatever the caller just wrote to disk, so no second one is
// queued; a job that is already RUNNING may have read the data before that
// write, so a fresh one is queued behind it.
function enqueue(name, steps) {
  const waiting = queue.find((q) => q.job.name === name);
  if (waiting) return waiting.job;
  const job = { name, state: 'queued', error: null, step: '', log: [] };
  latest[name] = job;
  queue.push({ job, steps });
  pump();
  return job;
}

function status(name) {
  const j = latest[name];
  if (!j) return { state: 'idle', running: false, done: false, error: null, progress: '', log: [] };
  return {
    state: j.state,
    running: j.state === 'queued' || j.state === 'running',
    done: j.state === 'done',
    error: j.error,
    step: j.step,
    progress: j.log[j.log.length - 1] || '',
    log: j.log.slice(-15),
  };
}

// Is anything (this queue only) currently queued or running?
function busy() { return !!running || queue.length > 0; }

module.exports = { REPO_ROOT, enqueue, status, busy };
