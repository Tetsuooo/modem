#!/usr/bin/env node
/*
 * scrape-modem.js — pull Modem show + year-end-list pages from radiostudent.si
 * (Drupal 11) into a single structured JSON file the website can search & render.
 *
 * This is a build/CI tool. It is NOT shipped to the site. Only its output,
 * src/assets/modem-archive.json, is copied into docs/ by webpack.
 *
 * For each numbered show it also resolves the full-show player on SoundCloud
 * (https://soundcloud.com/modemodemodem/modem-NN), verified via SoundCloud's
 * oEmbed endpoint, so playback streams from SoundCloud rather than hotlinking
 * radiostudent's MP3s.
 *
 * Usage:
 *   node scripts/scrape-modem.js              # scrape the POC set (uses cache)
 *   node scripts/scrape-modem.js --fresh      # ignore cache, re-fetch everything
 *   node scripts/scrape-modem.js --shows 233-242 --lists best-releases-of-2025
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(__dirname, '.cache');
const OUT_FILE = path.join(ROOT, 'src', 'assets', 'modem-archive.json');
const BASE = 'https://radiostudent.si';
const SC_USER = 'https://soundcloud.com/modemodemodem';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36';

// ---------- CLI ----------------------------------------------------------
const argv = process.argv.slice(2);
function argVal(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
const FRESH = argv.includes('--fresh');

const showRange = argVal('--shows') || '233-242';
const [lo, hi] = showRange.split('-').map(Number);
// radiostudent.si slug quirks. Most shows are plain "modem-N", but the earliest
// episodes are zero-padded and a few round-number specials have named slugs:
//   1        → modem-01-0        (2–9 zero-padded, "modem-0N")
//   100/200  → the "Bag of Toys" anniversary specials
const SLUG_OVERRIDES = {
  1: 'modem-01-0',
  100: 'modem-100-bag-of-toys',
  200: 'modem-200-bag-of-toys-2',
};
function showSlug(n) {
  if (SLUG_OVERRIDES[n]) return SLUG_OVERRIDES[n];
  if (n <= 9) return `modem-0${n}`;
  return `modem-${n}`;
}
const showSlugs = [];
for (let n = lo; n <= hi; n++) showSlugs.push(showSlug(n));
const listSlugs = (argVal('--lists') || 'best-releases-of-2025').split(',');

// ---------- tiny helpers -------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => (n < 10 ? `0${n}` : `${n}`);

function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&hellip;/g, '…');
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function balancedDiv(html, openIdx) {
  const tagRe = /<\/?div\b[^>]*>/gi;
  tagRe.lastIndex = openIdx;
  let depth = 0;
  let contentStart = null;
  let m;
  while ((m = tagRe.exec(html))) {
    const isClose = m[0][1] === '/';
    if (isClose) {
      depth--;
      if (depth === 0) return { inner: html.slice(contentStart, m.index), outerEnd: tagRe.lastIndex };
    } else {
      if (depth === 0) contentStart = html.indexOf('>', m.index) + 1;
      depth++;
    }
  }
  return null;
}

function fieldByClass(html, classRe) {
  const m = classRe.exec(html);
  if (!m) return null;
  const region = balancedDiv(html, m.index);
  return region ? region.inner : null;
}

function firstMatch(re, s, group = 1) {
  const m = re.exec(s);
  return m ? m[group] : null;
}

function abs(url) {
  if (!url) return url;
  return url.startsWith('http') ? url : BASE + url;
}

// Strip the stylised intro (zalgo/combining-mark paragraph), separator-only
// paragraphs (~~~) and empty/nbsp spacers — leaving just the tracklist.
function cleanBody(html) {
  if (!html) return html;
  let out = html;
  // Stylised zalgo/combining-mark intro banner ("M̫ODE̍M̫ VAS PREKO RADIA…") that
  // opens ~58 of the older shows. Keep a combining-mark line ONLY if it carries an
  // embed OR links to an artist/label MUSIC page (soundcloud/bandcamp, not the
  // modem's own account) — those are real headings whose names happen to use
  // combining marks (e.g. "s̶ummon"). The banner links only to modem's own
  // facebook/soundcloud, so it — and pure zalgo prose — is dropped.
  out = out.replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?[̀-ͯ](?:(?!<\/p>)[\s\S])*?<\/p>/g, (mm) => {
    if (/<iframe/i.test(mm)) return mm;
    // A "name /////" heading whose NAME happens to use combining marks (e.g.
    // "digital selves", "emotionalpastel") — never a banner; keep it so we don't
    // lose the segment. The intro banner is pure prose with no slash run.
    if (/\/{3,}/.test(stripTags(mm))) return mm;
    const links = [...mm.matchAll(/href="([^"]+)"/gi)].map((x) => x[1]);
    const artistLink = links.some((h) =>
      (/soundcloud\.com\//i.test(h) && !/soundcloud\.com\/modemodemodem/i.test(h)) || /bandcamp\.com/i.test(h));
    return artistLink ? mm : '';
  });
  // "modemodemodem…" banner (div or p that is only the repeated 'm(odem)+' run)
  out = out.replace(/<(div|p)\b[^>]*>\s*m(?:odem)+\s*<\/\1>/gi, '');
  // internal nav lines cross-linking another modem page (e.g. "//// community lists ////")
  out = out.replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?\/glasba\/modem\/(?:(?!<\/p>)[\s\S])*?<\/p>/gi, '');
  // the "~~~~"/"----" separator bars that sit under the banner — even when wrapped
  // in a link to the modem's own account (so the plain-separator rule below misses them)
  out = out.replace(/<p\b[^>]*>(?:(?!<\/p>)[\s\S])*?<\/p>/g, (mm) => {
    const links = [...mm.matchAll(/href="([^"]+)"/gi)].map((x) => x[1]);
    if (!links.length || !links.every((h) => /modemodemodem/i.test(h))) return mm;
    return /^[~\-–—_.\s]*$/.test(stripTags(mm)) ? '' : mm;
  });
  // separator-only (~~~) and empty/nbsp spacer paragraphs
  out = out.replace(/<p\b[^>]*>(?:\s|&nbsp;|~|<br\s*\/?>)*<\/p>/gi, '');
  return out.replace(/\n{2,}/g, '\n').trim();
}

// Normalise a name for matching: lowercase, fold superscripts/diacritics (NFKD),
// keep only [a-z0-9]. CJK/Cyrillic fold to '' and are matched raw instead.
function norm(s) {
  return (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

// The earliest shows tuck each entry's SoundCloud/Bandcamp page link INTO the
// slash run of its heading (and sometimes link several entities from one line).
// Pull the identifying handle out of every such link so a tag can be tied to its
// segment even when the visible heading name differs from the profile slug.
function handlesFromHeading(inner) {
  const out = [];
  const aRe = /href="([^"]+)"/gi;
  let a;
  while ((a = aRe.exec(inner))) {
    const h = a[1];
    let tok = null, mm;
    if ((mm = h.match(/soundcloud\.com\/([^/?"]+)/i))) tok = mm[1];
    else if ((mm = h.match(/https?:\/\/([^./]+)\.bandcamp\.com/i))) tok = mm[1];
    else if ((mm = h.match(/bandcamp\.com\/([^/?"]+)/i))) tok = mm[1];
    if (tok && !/^(www|w|player|track|album|releases|sets|embed|watch|user-\d+|modemodemodem)$/i.test(tok)) {
      out.push(norm(tok));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

// Keep every hyperlink but tame the marathon slash runs the early shows use, so
// each heading reads at a consistent length like the recent shows (links stay
// clickable — only the slash count shrinks).
function shortenSlashRuns(inner) {
  return inner.replace(/\/{8,}/g, '///////');
}

// Split the tracklist into segments at the "name /////" heading markers, tag each
// marker paragraph with data-seg="i" (for in-page scrolling + chip injection), and
// return the annotated body plus the ordered segment labels.
//
// Handles two heading dialects with one pass:
//   recent   <p>Name /////////////////</p>
//   early A  <p>Name <a href=…>////</a>///<a href=…>////</a>////</p>   (links in the slashes)
//   early B  <p><strong>Name</strong></p><p><a href=…>/////</a>…</p>  (name split above the slashes)
// A heading is any <p> whose visible text carries a run of >=3 slashes; its label
// is the text before that run, or — when the slashes stand alone in their own
// paragraph — the short text paragraph immediately above (folded in, early B).
function annotateAndSegment(body) {
  if (!body) return { body: body, segments: [] };

  // ordered <p> blocks + the gaps between them
  const parts = [];
  const pRe = /<p\b[^>]*>[\s\S]*?<\/p>/gi;
  let last = 0, m;
  while ((m = pRe.exec(body))) {
    if (m.index > last) parts.push({ p: false, html: body.slice(last, m.index) });
    parts.push({ p: true, html: m[0], inner: m[0].replace(/^<p\b[^>]*>/i, '').replace(/<\/p>$/i, '') });
    last = pRe.lastIndex;
  }
  if (last < body.length) parts.push({ p: false, html: body.slice(last) });

  const cls = parts.map((pt) => {
    if (!pt.p) return { kind: 'gap' };
    const text = stripTags(pt.inner);
    const hasEmbed = /<iframe/i.test(pt.inner);
    const sl = text.search(/\/{3,}/);
    if (sl === -1) return { kind: 'other', text, hasEmbed };
    return { kind: 'slash', text, label: text.slice(0, sl).trim(), hasEmbed };
  });

  const isHead = new Array(parts.length).fill(false);
  const headLabel = new Array(parts.length).fill(null);
  const mergeFrom = new Array(parts.length).fill(-1);
  const consumed = new Array(parts.length).fill(false);
  for (let i = 0; i < parts.length; i++) {
    if (cls[i].kind !== 'slash') continue;
    let label = cls[i].label, from = -1;
    if (!label) {
      // A pure-slash paragraph that also carries an embed but no name is ambiguous
      // (can't tell whose it is) — leave it un-segmented.
      if (cls[i].hasEmbed) continue;
      // early-B: the slashes are alone in their paragraph — borrow the name from
      // the nearest preceding short, non-embed text paragraph and fold it in.
      for (let j = i - 1; j >= 0; j--) {
        if (!parts[j].p) { if (parts[j].html.trim()) break; else continue; }
        if (cls[j].kind === 'slash' || cls[j].hasEmbed) break;
        const t = (cls[j].text || '').trim();
        if (t && t.length <= 60) { label = t; from = j; }
        break;
      }
    }
    if (!label) continue;
    isHead[i] = true; headLabel[i] = label;
    if (from >= 0) { mergeFrom[i] = from; consumed[from] = true; }
  }

  let out = '';
  const segments = [];
  let idx = 0;
  for (let i = 0; i < parts.length; i++) {
    if (consumed[i]) continue;
    const pt = parts[i];
    if (!pt.p) { out += pt.html; continue; }
    if (!isHead[i]) { out += pt.html; continue; }
    let inner = pt.inner;
    if (mergeFrom[i] >= 0) {
      const nm = (cls[mergeFrom[i]].text || '').trim()
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      inner = nm + ' ' + inner; // fold the name paragraph into the slash line
    }
    // Some early shows put the heading's name+slashes and its embed in ONE <p>
    // (e.g. "<strong>PAN ////</strong><iframe…>"). Split the embed into its own
    // paragraph so every heading is just the name+slashes, like the recent shows.
    let trailing = '';
    const ifIdx = inner.search(/<iframe/i);
    if (ifIdx !== -1) { trailing = inner.slice(ifIdx); inner = inner.slice(0, ifIdx); }
    inner = shortenSlashRuns(inner);
    out += `<p data-seg="${idx}" class="seg-marker">${inner}</p>`;
    if (trailing.trim()) out += `<p>${trailing}</p>`;
    segments.push({ index: idx, label: headLabel[i], handles: handlesFromHeading(inner) });
    idx++;
  }
  return { body: out, segments };
}

// Some shows paste a SoundCloud embed (which carries its own caption naming a
// DIFFERENT artist) directly under the previous entry's "name /////" heading,
// with no heading of its own — so it wrongly folds into that entry. Give it its
// own entry: when such a captioned embed's artist differs from the current
// heading, inject a synthetic heading before it. It only fires on a mismatch, so
// an artist's own tracks stay grouped under their heading; a SoundCloud VA under
// a single label heading is the rare case that also splits, which is acceptable.
function splitStrayEmbeds(body) {
  if (!body) return body;
  // walk headings and captioned-soundcloud embeds in document order
  const re = /<p>[^<]*?\/{3,}[^<]*<\/p>|<p>\s*<iframe\b[^>]*soundcloud[^>]*>[\s\S]*?<\/iframe>\s*<\/p>\s*<div>[\s\S]*?<\/div>/gi;
  let curHead = null, out = '', last = 0, m;
  while ((m = re.exec(body))) {
    const block = m[0];
    out += body.slice(last, m.index);
    last = m.index + block.length;
    if (/<iframe/i.test(block)) {
      // captioned soundcloud embed → its artist is the first soundcloud user link
      const cap = block.match(/<a\s+href="https?:\/\/soundcloud\.com\/[^"/]+"[^>]*>([\s\S]*?)<\/a>/i);
      const artist = cap ? decodeEntities(cap[1].replace(/<[^>]+>/g, '').trim()) : '';
      const an = norm(artist);
      if (an && an !== curHead) {
        const label = artist.replace(/[<>]/g, '').replace(/\/{2,}/g, '/');
        out += '<p>' + label + ' //////////////////////////////////</p>\n';
        curHead = an;
      }
    } else {
      // a "name /////" heading
      curHead = norm(decodeEntities((block.replace(/<[^>]+>/g, '').split(/\/{3,}/)[0] || '').trim()));
    }
    out += block;
  }
  return out + body.slice(last);
}

// Attach a matching segment index to each artist/label where the show clearly
// marks their track. Match priority: exact normalised name === segment label, then
// exact raw label, then the tag's name against a handle linked inside the heading
// (how the early shows tie an entity to its slashes), then a loose contains match.
function attachSegments(list, segments) {
  return list.map((item) => {
    const nk = norm(item.name);
    const raw = item.name.trim().toLowerCase().replace(/\s+/g, ' ');
    let seg = null;
    for (const s of segments) if (nk && norm(s.label) === nk) { seg = s.index; break; }
    if (seg === null) for (const s of segments) if (s.label.trim().toLowerCase().replace(/\s+/g, ' ') === raw) { seg = s.index; break; }
    if (seg === null) for (const s of segments) if (nk && (s.handles || []).includes(nk)) { seg = s.index; break; }
    if (seg === null) for (const s of segments) {
      const sl = norm(s.label);
      if (nk && sl && (sl.includes(nk) || nk.includes(sl))) { seg = s.index; break; }
    }
    return { ...item, seg };
  });
}

// ---------- cached fetch (curl) -----------------------------------------
function cachedCurl(cacheKey, url, isLive) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, cacheKey.replace(/[^\w.-]/g, '_'));
  if (!FRESH && fs.existsSync(cacheFile)) {
    return { body: fs.readFileSync(cacheFile, 'utf8'), cached: true };
  }
  const body = execFileSync(
    'curl',
    ['-sS', '-L', '--compressed', '-A', UA, '-H', 'Accept-Language: sl,en;q=0.9', url],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
  );
  fs.writeFileSync(cacheFile, body);
  isLive.hit = true;
  return { body, cached: false };
}

// Resolve & verify the full-show SoundCloud player via oEmbed.
function resolveSoundcloud(number, live) {
  if (!number) return null;
  const trackUrl = `${SC_USER}/modem-${pad(number)}`;
  const oembed = `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(trackUrl)}`;
  let res;
  try {
    res = cachedCurl(`sc-modem-${pad(number)}.json`, oembed, live);
  } catch (e) {
    return null;
  }
  let data;
  try {
    data = JSON.parse(res.body);
  } catch (e) {
    return null; // 404 pages aren't JSON
  }
  if (!data || !data.html) return null;
  const src = firstMatch(/src="([^"]+)"/, data.html);
  const apiUrl = src ? firstMatch(/[?&]url=([^&"]+)/, src) : null;
  return {
    track: trackUrl,
    api: apiUrl ? decodeURIComponent(apiUrl) : null, // api.soundcloud.com/tracks/<id>
    title: data.title || null,
    artwork: data.thumbnail_url || null,
  };
}

// ---------- parse one page ----------------------------------------------
function parsePage(slug, html, type, soundcloud) {
  const number = type === 'show' ? Number(firstMatch(/modem-(\d+)/, slug)) : null;

  const title = decodeEntities(
    firstMatch(/<meta property="og:title" content="([^"]*)"/, html) ||
      stripTags(firstMatch(/<h1 class="page-title">([\s\S]*?)<\/h1>/, html) || '')
  );
  const canonical =
    firstMatch(/<link rel="canonical" href="([^"]*)"/, html) || `${BASE}/glasba/modem/${slug}`;
  const cover = abs(firstMatch(/<meta property="og:image" content="([^"]*)"/, html));

  const dateRaw = stripTags(
    fieldByClass(html, /<div class="field field--name-field-v-etru[^"]*field__item">/) || ''
  );
  const dateShort = dateRaw ? dateRaw.split(/\s[–—-]\s/)[0].trim() : null; // drop the "– 22.00" time

  const mp3 = abs(firstMatch(/href="(\/sites\/default\/files\/posnetki\/[^"]+\.mp3)"/, html));

  const rawBody = fieldByClass(html, /<div class="field field--name-body[^"]*field__item">/) || '';
  // Videos frequently live in a SEPARATE Drupal field ("field-video", a
  // video-embed-field) rather than the body — this is how the best-videos-of-*
  // lists and many older shows carry their YouTube clips. Pull those iframes in
  // so they render on the detail page AND get indexed like any other embed.
  const videoField = fieldByClass(html, /<div class="field field--name-field-video[^"]*">/) || '';
  const videoIframes = (videoField.match(/<iframe[\s\S]*?<\/iframe>/gi) || [])
    .filter((f) => /youtu\.?be|youtube\.com/i.test(f))
    .map((f) => '<p>' + f + '</p>');
  const rawBodyPlus = rawBody + (videoIframes.length ? '\n' + videoIframes.join('\n') : '');
  // splitStrayEmbeds only makes sense for shows (heading-delimited tracklists);
  // year-end lists are description-per-entry and are handled differently in the UI.
  const cleanedBody = cleanBody(rawBodyPlus);
  const cleaned = type === 'show' ? splitStrayEmbeds(cleanedBody) : cleanedBody;
  const { body: bodyHtml, segments } = annotateAndSegment(cleaned);

  function anchorList(blockRe) {
    const block = fieldByClass(html, blockRe);
    if (!block) return [];
    const out = [];
    const re = /<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
    let m;
    while ((m = re.exec(block))) out.push({ name: decodeEntities(m[2].trim()), url: abs(m[1]) });
    return out;
  }
  const artists = attachSegments(anchorList(/<div class="field field--name-field-umetniki[^"]*">/), segments);
  const labels = attachSegments(anchorList(/<div class="field field--name-field-zalozba[^"]*">/), segments);
  const embeds = extractEmbeds(bodyHtml || '');

  const searchText = [
    title,
    dateShort,
    artists.map((a) => a.name).join(' '),
    labels.map((l) => l.name).join(' '),
    stripTags(bodyHtml || ''),
  ]
    .filter(Boolean)
    .join(' \n ');

  return {
    type,
    slug,
    number,
    title,
    url: canonical,
    date: dateShort,
    cover,
    mp3,
    soundcloud: soundcloud || null,
    artists,
    labels,
    embeds,
    segments: segments.map((s) => s.label),
    bodyHtml: bodyHtml || null,
    searchText,
  };
}

function extractEmbeds(body) {
  const embeds = [];
  let m;
  const bcRe = /<iframe[^>]+src="(https:\/\/bandcamp\.com\/EmbeddedPlayer\/[^"]+)"/g;
  while ((m = bcRe.exec(body))) embeds.push({ kind: 'bandcamp', src: m[1] });
  const scRe = /<iframe[^>]+src="(https:\/\/w\.soundcloud\.com\/player\/[^"]+)"/g;
  while ((m = scRe.exec(body))) embeds.push({ kind: 'soundcloud', src: decodeEntities(m[1]) });
  const ytRe =
    /(?:src="|href=")(https?:\/\/(?:www\.)?(?:youtube\.com\/embed\/[^"]+|youtube\.com\/watch\?[^"]+|youtu\.be\/[^"]+))"/g;
  while ((m = ytRe.exec(body))) embeds.push({ kind: 'youtube', src: m[1] });
  return embeds;
}

// ---------- main ---------------------------------------------------------
(async () => {
  // --reparse: re-parse every page already in the archive straight from cache
  // (raw, un-edited records) — used by the admin save so tag merges/un-merges are
  // always derived from the source rather than accumulating on mutated data.
  let targets;
  if (argv.includes('--reparse') && fs.existsSync(OUT_FILE)) {
    const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).records || [];
    targets = prev.map((r) => ({ slug: r.slug, type: r.type }));
    console.log('reparse: ' + targets.length + ' existing pages from cache');
  } else {
    targets = [
      ...showSlugs.map((s) => ({ slug: s, type: 'show' })),
      ...listSlugs.map((s) => ({ slug: s, type: 'list' })),
    ];
  }

  const records = [];
  let liveHits = 0;
  for (const t of targets) {
    try {
      const live = { hit: false };
      const { body: html, cached } = cachedCurl(`${t.slug}.html`, `${BASE}/glasba/modem/${t.slug}`, live);
      if (live.hit) {
        liveHits++;
        await sleep(1200);
      }
      // Radio Študent serves a full-size (17 KB) themed 404 for missing slugs, so a
      // byte-length check isn't enough — detect the "page not found" title and the
      // homepage canonical it falls back to.
      const notFound =
        /<title>\s*Stran ni bila najdena/i.test(html) ||
        /<link rel="canonical" href="https:\/\/radiostudent\.si\/"\s*\/?>/i.test(html);
      if (/HTTP 502|Bad Gateway/i.test(html) || html.length < 500 || notFound) {
        console.warn(`  ! ${t.slug}: looks like an error page (${html.length} bytes), skipping`);
        continue;
      }

      let soundcloud = null;
      if (t.type === 'show') {
        const num = Number(firstMatch(/modem-(\d+)/, t.slug));
        const scLive = { hit: false };
        soundcloud = resolveSoundcloud(num, scLive);
        if (scLive.hit) {
          liveHits++;
          await sleep(800);
        }
      }

      const rec = parsePage(t.slug, html, t.type, soundcloud);
      records.push(rec);
      console.log(
        `  ✓ ${t.slug.padEnd(24)} ${cached ? '(cache)' : '(live) '} ` +
          `artists:${String(rec.artists.length).padStart(2)} ` +
          `labels:${String(rec.labels.length).padStart(2)} ` +
          `embeds:${String(rec.embeds.length).padStart(2)}` +
          `${rec.soundcloud ? ' sc✓' : rec.mp3 ? ' mp3' : ''}`
      );
    } catch (e) {
      console.warn(`  ! ${t.slug}: ${e.message}`);
    }
  }

  // Merge into any existing archive so scraping a few shows is ADDITIVE — it never
  // drops the shows/lists you already have. Records are keyed by slug; a freshly
  // scraped record replaces its old copy, everything else is preserved untouched.
  // (`tracks` and `scPlay` are intentionally not carried here — they're rebuilt by
  // build-track-index.js + apply-sc-matches.js, which re-reads your durable
  // approvals.json. Those two are the required next steps after any scrape.)
  // Pass --replace to force the old wipe-and-write behaviour.
  let merged = records;
  let prevData = null;
  const scrapedSlugs = new Set(records.map((r) => r.slug));
  if (!argv.includes('--replace') && fs.existsSync(OUT_FILE)) {
    try {
      prevData = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      const prev = prevData.records || [];
      const bySlug = new Map(prev.map((r) => [r.slug, r]));
      records.forEach((r) => bySlug.set(r.slug, r)); // scraped wins over old copy
      merged = [...bySlug.values()];
      const kept = merged.length - records.length;
      if (kept > 0) console.log(`  merged: kept ${kept} existing record(s), (re)wrote ${records.length}`);
    } catch (e) {
      console.warn('  ! could not merge with existing archive, writing scraped only: ' + e.message);
    }
  }

  merged.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'show' ? -1 : 1;
    return (b.number || 0) - (a.number || 0) || a.slug.localeCompare(b.slug);
  });

  const out = {
    generatedAt: new Date().toISOString(),
    source: `${BASE}/glasba/modem`,
    counts: {
      total: merged.length,
      shows: merged.filter((r) => r.type === 'show').length,
      lists: merged.filter((r) => r.type === 'list').length,
      withSoundcloud: merged.filter((r) => r.soundcloud).length,
      lastScraped: [...scrapedSlugs],
    },
    records: merged,
  };
  // Carry the previous track index forward so the LIVE site keeps working in the
  // gap between this scrape and the build-track-index.js rebuild (which replaces
  // `tracks`). Without this the file is briefly track-less → search / play-random
  // go empty mid-pipeline. The tracks are stale (missing the new shows) only until
  // build-track-index runs. counts.tracks/scMatched follow along.
  if (prevData && Array.isArray(prevData.tracks)) {
    out.tracks = prevData.tracks;
    out.tracksGeneratedAt = prevData.tracksGeneratedAt;
    out.counts.tracks = prevData.tracks.length;
    if (prevData.counts && prevData.counts.scMatched != null) out.counts.scMatched = prevData.counts.scMatched;
    out.tracksStale = true; // build-track-index.js clears this when it rewrites
  }
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(
    `\nWrote ${merged.length} records total — ${records.length} scraped this run ` +
      `(${out.counts.withSoundcloud} with SoundCloud) → ` +
      `${path.relative(ROOT, OUT_FILE)} (${liveHits} live fetches)`
  );
})();
