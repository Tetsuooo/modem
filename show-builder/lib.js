// Small shared helpers for the show-builder scanners/server. Unlike scripts/
// (which keeps every scraper self-contained), this is a brand-new, dedicated
// folder with three files that all need the same curl+cache plumbing, so one
// shared module beats copy-pasting it three times.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;
const CACHE_DIR = path.join(ROOT, 'data', '.cache');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// Always-live GET (scan results should never be stale) — plain curl, no cache.
function curlGet(url, extraHeaders) {
  const headers = Object.assign({ 'Accept-Language': 'en-us,en;q=0.9' }, extraHeaders || {});
  const args = ['-sS', '-L', '--compressed', '--max-time', '25', '-A', UA];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(url);
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

// Always-live POST with a JSON body (Bandcamp's fancollection API).
function curlPostJson(url, bodyObj) {
  const args = [
    '-sS', '-L', '--max-time', '25', '-A', UA,
    '-H', 'Content-Type: application/json',
    '-d', JSON.stringify(bodyObj),
    url,
  ];
  return execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 });
}

// Small persistent cache for slow-changing single values (client_id, fan_id) —
// distinct from scan results, which must always be fetched live.
function cacheGet(key) {
  ensureCacheDir();
  const file = path.join(CACHE_DIR, key + '.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function cacheSet(key, value) {
  ensureCacheDir();
  const file = path.join(CACHE_DIR, key + '.json');
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// A name without invisible formatting characters — Bandcamp hands some out with
// direction marks in them ("Computer‎ ‎man"), which then didn't match the same
// name typed plainly (a group heading that looked like the artist got tagged as a label,
// 2026-10-24). Zero-width/direction/isolate marks and BOMs go; ZWJ (U+200D) and ZWNJ
// (U+200C) stay — emoji sequences and some scripts need them. Spaces collapse to one.
function cleanName(s) {
  return String(s == null ? '' : s)
    .replace(/[​‎‏‪-‮⁠⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// The key for "is this the same name?", used wherever names are compared: is a group's
// heading one of its artists (then it's no label), do neighbours share a heading, is a name
// a duplicate. Case, spaces, accents, invisible marks and styling punctuation
// (. _ * | ~ ^ ; : ` ' " ( ) [ ] -) don't count: "Computer man" = "computer-man" =
// "COMPUTER MAN" = the same with invisible marks. Same rule as the site's hardKey()
// (src/archive.html), which drops a label chip that just restates the artist. & / , ! ?
// and letters/digits count. A name that is only punctuation is compared as it is.
function nameKey(s) {
  const c = cleanName(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  return c.replace(/[\s._*|~^;:`'"()\[\]\-]/g, '') || c;
}

module.exports = { ROOT, CACHE_DIR, UA, curlGet, curlPostJson, cacheGet, cacheSet, escapeHtml, cleanName, nameKey };
