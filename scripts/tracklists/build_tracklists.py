"""Live tracklists for Modem shows: where every track starts in the show recording.

Per show:
  tracklist  the iTunes playlist "modemN" (what was actually played, in order, with lengths)
             when there is one, else the show page's embeds in page order
  linking    each playlist entry is paired with the show page's track (similar title/artist,
             in order) -> the site's cover art + bandcamp / soundcloud links
  audio      show: D:/MODEM/oddaje/Modem_NNN_*.mp3 (identical to the SoundCloud upload), else
             the SoundCloud upload. Track: its own file on D: (HEWZ muska), else the Bandcamp /
             SoundCloud stream of the paired page track
  matching   12 s spectrogram pieces of each track, normalised cross-correlation along the whole
             show, the best chain in tracklist order; then which part of each track is heard
Tracks with no audio (or not found) are placed in the gap between their neighbours by length.
Writes <work>/<slug>/result.json (cached; delete it to redo a show), and with --site-json the
site's src/assets/show-timestamps.json. The work folder keeps fingerprints (.npy) of every show
and track (a few GB), so re-runs don't download or decode again.
Needs: Python 3 with numpy + scipy, ffmpeg, curl and yt-dlp on PATH.
usage: python build_tracklists.py <N|N-M,..|all> [--jobs 3] [--work DIR] [--site-json PATH]
"""
import argparse, difflib, glob, html, json, os, plistlib, re, subprocess, sys, time, unicodedata, urllib.parse, wave
from multiprocessing import Pool
import numpy as np
from scipy.signal import fftconvolve

ARCHIVE = 'E:/ART/websites/modem_/src/assets/modem-archive.json'
LIBRARY = 'C:/Users/Matej/Downloads/Library.xml'
SHOWS_DIR = 'D:/MODEM/oddaje'
# 'modem248' is Matej's dump of tracks he didn't use, never a show
IGNORE_PLAYLISTS = {248}
HEWZ = 'D:/HEWZ muska'                                   # Matej's music drive (the playlists' files)
# The Mac whose iTunes library the playlists come from (macOS Sierra, File Sharing / SMB on:
# shares "Music" and "matejmihevc"). Most playlist tracks that aren't on D: are there.
# Set MODEM_MAC='' to skip it when the Mac isn't on.
MAC = os.environ.get('MODEM_MAC', '//192.168.100.6')
MAC_SHARES = (('/Users/matejmihevc/Music/', 'Music/'), ('/Users/matejmihevc/', 'matejmihevc/'))
WORK = 'E:/ART/websites/modem-tracklists-work'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

SR, NFFT, HOP = 11025, 1024, 512
FPS = SR / HOP
BANDS, TPL, MIN_GAP, SKIP = 32, 12.0, 4.0, 0.15
edges = np.geomspace(80, 5000, BANDS + 1)
freqs = np.fft.rfftfreq(NFFT, 1 / SR)
BAND_IDX = [np.where((freqs >= edges[b]) & (freqs < edges[b + 1]))[0] for b in range(BANDS)]
WIN = np.hanning(NFFT).astype(np.float32)


# ---------------------------------------------------------------- audio + fingerprints
def run(args):
    return subprocess.run(args, capture_output=True, check=True)


def to_wav(src, dst):
    run(['ffmpeg', '-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', str(SR), '-sample_fmt', 's16', dst])


def load(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def feats(x):
    n = 1 + max(0, (len(x) - NFFT) // HOP)
    out = np.empty((n, BANDS), np.float32)
    for a in range(0, n, 8192):                       # chunked: a 2 h show would need GBs at once
        b = min(n, a + 8192)
        idx = np.arange(NFFT)[None, :] + HOP * np.arange(a, b)[:, None]
        spec = np.abs(np.fft.rfft(x[idx] * WIN, axis=1)) ** 2
        out[a:b] = np.stack([spec[:, bi].sum(1) for bi in BAND_IDX], 1)
    f = np.log(out + 1e-6)
    f -= f.mean(0, keepdims=True)
    f -= f.mean(1, keepdims=True)
    return f


def feats_cached(wav):
    npy = wav[:-4] + '.npy'
    if os.path.exists(npy):
        return np.load(npy)
    f = feats(load(wav))
    np.save(npy, f)
    return f


class Show:
    def __init__(self, F):
        self.F = F
        self.c1 = np.concatenate([[0], np.cumsum(F.sum(1, dtype=np.float64))])
        self.c2 = np.concatenate([[0], np.cumsum((F.astype(np.float64) ** 2).sum(1))])

    def ncc(self, T):
        L = len(T)
        T = T - T.mean(); T = T / (np.linalg.norm(T) + 1e-9)
        num = fftconvolve(self.F, T[::-1, ::-1], mode='valid')[:, 0]
        n = L * T.shape[1]
        s1 = self.c1[L:] - self.c1[:-L]; s2 = self.c2[L:] - self.c2[:-L]
        return num / np.sqrt(np.maximum(s2 - s1 * s1 / n, 1e-9))


def peaks(v, k, sep):
    v = v.copy(); out = []
    for _ in range(k):
        i = int(np.argmax(v))
        if v[i] <= 0: break
        out.append((i, float(v[i]))); v[max(0, i - sep): i + sep] = -1
    return out


# ---------------------------------------------------------------- sources
def norm(s):
    raw = unicodedata.normalize('NFKC', str(s or '')).lower().strip()
    s = unicodedata.normalize('NFKD', str(s or '')).encode('ascii', 'ignore').decode().lower()
    if not re.sub(r'[^a-z0-9]', '', s):              # all symbols / non-latin: compare as written
        return re.sub(r'\s+', ' ', raw)
    s = re.sub(r'-\d{6,}$', '', s)                   # bandcamp download id suffix
    s = re.sub(r'^\s*\d{1,2}[.\s-]+', '', s)         # leading track number
    s = re.sub(r'\((feat|ft|with|w)[^)]*\)|\[[^\]]*\]', '', s)
    return re.sub(r'[^a-z0-9]+', ' ', s).strip()


def clean_name(name, artist):
    """iTunes names are often 'Artist - Title-123456789'; keep the title."""
    n = re.sub(r'-\d{6,}$', '', str(name or '')).strip()
    if ' - ' in n and artist and norm(n.split(' - ')[0]) == norm(artist):
        n = n.split(' - ', 1)[1]
    return n


def sim(a_title, a_artist, b_title, b_artist):
    r = lambda x, y: difflib.SequenceMatcher(None, x, y).ratio()
    t1, t2 = norm(a_title), norm(b_title)
    if not t1 or not t2: return 0.0
    st = r(t1, t2)
    if t1 in t2 or t2 in t1: st = max(st, 0.85)
    sa = r(norm(a_artist), norm(b_artist)) if a_artist and b_artist else 0.5
    best = 0.75 * st + 0.25 * sa
    # "artist - title" written all in one field, on either side
    best = max(best, r(norm(f'{a_artist} {a_title}'), norm(f'{b_artist} {b_title}')) - 0.05)
    # an entry named only by its artist ("nicola ratti")
    if not a_artist and r(t1, norm(b_artist)) >= 0.9: best = max(best, 0.7)
    return best


def pair(items, site):
    """order-preserving pairing of playlist items with page tracks (weighted LCS)"""
    n, m = len(items), len(site)
    S = [[sim(it['title'], it['artist'], s['title'], s['artist']) for s in site] for it in items]
    D = [[0.0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            take = D[i + 1][j + 1] + S[i][j] if S[i][j] >= 0.6 else -1
            D[i][j] = max(take, D[i + 1][j], D[i][j + 1])
    i = j = 0; out = {}
    while i < n and j < m:
        if S[i][j] >= 0.6 and abs(D[i][j] - (D[i + 1][j + 1] + S[i][j])) < 1e-9:
            out[i] = j; i += 1; j += 1
        elif D[i + 1][j] >= D[i][j + 1]: i += 1
        else: j += 1
    # leftovers that clearly match, whatever their order (playlist and page can disagree)
    used = set(out.values())
    for i in range(n):
        if i in out: continue
        cand = [(S[i][j], j) for j in range(m) if j not in used and S[i][j] >= 0.8]
        if cand:
            sc, j = max(cand); out[i] = j; used.add(j)
    return out


def site_tracks(rec, by_key):
    sc_id = lambda src: ((re.search(r'(\d{5,})', urllib.parse.unquote((re.search(r'[?&]url=([^&]+)', src) or [None, ''])[1])) or [None, None])[1])
    def key_of(src):
        if re.search(r'soundcloud\.com', src, re.I):
            i = sc_id(src); return 'sc:' + i if i else None
        alb = (re.search(r'album=(\d+)', src) or [None, None])[1]; trk = (re.search(r'track=(\d+)', src) or [None, None])[1]
        return 'bc:' + (alb or '-') + ':' + (trk or '-') if (alb or trk) else None
    srcs = [html.unescape(m) for m in re.findall(r'<iframe[^>]+src="([^"]+)"', rec.get('bodyHtml') or '', re.I)]
    if not srcs: srcs = [e['src'] for e in rec.get('embeds') or []]
    out, seen = [], set()
    for src in srcs:
        k = key_of(src)
        if not k or k in seen: continue
        seen.add(k); t = by_key.get(k)
        if t: out.append({'key': k, 'title': t.get('title'), 'artist': t.get('artist'), 'kind': t.get('kind'), 'embed': src, 'duration': t.get('duration')})
    return out


def hewz_index():
    """file name -> paths of every audio file on the music drive (files that moved since the
    library was exported are still found by name)"""
    path = os.path.join(WORK, 'hewz-index.json')
    if not os.path.exists(path):
        idx = {}
        for root, _, files in os.walk(HEWZ):
            for f in files:
                if f.lower().endswith(('.mp3', '.m4a', '.wav', '.flac', '.aif', '.aiff', '.ogg', '.aac', '.opus')):
                    idx.setdefault(f.lower(), []).append(os.path.join(root, f))
        os.makedirs(WORK, exist_ok=True)
        json.dump(idx, open(path, 'w', encoding='utf-8'))
    return json.load(open(path, encoding='utf-8'))


def by_name(loc, artist, album, idx):
    """a playlist file that moved on the music drive, found by its file name. Names like
    'Track 3.mp3' are shared by many files, so the folder must name the artist or album,
    or the name must be unique and distinctive."""
    name = os.path.basename(loc)
    cands = idx.get(name.lower()) or []
    want = [w for w in (norm(artist), norm(album)) if len(w) >= 3]
    for c in cands:
        folders = norm(' '.join(os.path.normpath(c).split(os.sep)[-3:-1]))
        if any(w in folders for w in want): return c
    stem = norm(os.path.splitext(name)[0])
    if len(cands) == 1 and len(stem) >= 12 and not re.fullmatch(r'(track|untitled|audio|\d+)[ \d]*', stem):
        return cands[0]
    return None


def on_mac(loc):
    """the library's own path, read from the Mac over the network"""
    if not MAC: return None
    for pre, share in MAC_SHARES:
        if loc.startswith(pre):
            p = f'{MAC}/{share}{loc[len(pre):]}'
            return p if os.path.exists(p) else None
    return None


_lib = None
def playlists():
    global _lib
    if _lib is None:
        d = plistlib.load(open(LIBRARY, 'rb')); T = d['Tracks']
        idx = hewz_index()
        _lib = {}
        for p in d['Playlists']:
            m = re.fullmatch(r'modem\s*(\d+)', p.get('Name', '').strip(), re.I)
            if not m or int(m.group(1)) in IGNORE_PLAYLISTS: continue
            items = []
            for it in p.get('Playlist Items', []):
                t = T.get(str(it['Track ID'])) or T.get(it['Track ID'])
                loc = urllib.parse.unquote(t.get('Location', '')).replace('file://', '')
                mm = re.match(r'^/Volumes/HEWZZ?(?: 1)?/(HEWZ muska/.*)$', loc)
                artist = t.get('Artist') or ''
                path = ('D:/' + mm.group(1)) if mm and os.path.exists('D:/' + mm.group(1)) else (on_mac(loc) or by_name(loc, artist, t.get('Album'), idx))
                items.append({'title': clean_name(t.get('Name'), artist), 'artist': artist, 'album': t.get('Album'),
                              'duration': (t.get('Total Time') or 0) / 1000 or None, 'path': path})
            _lib[int(m.group(1))] = items
    return _lib


def bc_stream(embed):
    trk = (re.search(r'track=(\d+)', embed) or [None, None])[1]
    time.sleep(0.6)
    page = run(['curl', '-s', '-L', '--max-time', '60', '-A', UA, embed]).stdout.decode('utf-8', 'replace')
    m = re.search(r'data-player-data="([^"]+)"', page)
    if not m: return None
    tracks = json.loads(html.unescape(m.group(1))).get('tracks') or []
    pick = next((t for t in tracks if str(t.get('id')) == str(trk)), None) if trk else (tracks[0] if len(tracks) == 1 else None)
    return ((pick or {}).get('file') or {}).get('mp3-128')


def src_done(wav, src, why):
    json.dump({'src': src, 'why': why}, open(wav[:-4] + '.src', 'w', encoding='utf-8'))
    return src


def get_audio(dst_wav, local=None, site=None):
    """the item's audio as a wav: own file, else the paired page track's stream"""
    why = json.dumps([local, (site or {}).get('key')])
    srcf = dst_wav[:-4] + '.src'
    if os.path.exists(dst_wav) or os.path.exists(dst_wav[:-4] + '.npy'):
        try:
            got = json.load(open(srcf, encoding='utf-8'))
            if got.get('why') == why: return got['src']
            site_key = (site or {}).get('key')
            if got.get('src') in ('bandcamp', 'soundcloud') and site_key and json.loads(got['why'])[1] == site_key:
                return got['src']
        except Exception:
            pass
        for f in (dst_wav, dst_wav[:-4] + '.npy', srcf):        # made from another source: redo
            if os.path.exists(f): os.remove(f)
    if os.path.exists(dst_wav + '.none') and open(dst_wav + '.none').read() == why: return None
    base = dst_wav[:-4]
    try:
        if local and os.path.exists(local):
            to_wav(local, dst_wav); return src_done(dst_wav, 'local', why)
        if site and site.get('kind') == 'bandcamp':
            url = bc_stream(site['embed'])
            if url:
                run(['curl', '-s', '-L', '--max-time', '180', '-A', UA, '-o', base + '.mp3', url])
                to_wav(base + '.mp3', dst_wav); os.remove(base + '.mp3'); return src_done(dst_wav, 'bandcamp', why)
        if site and site.get('kind') == 'soundcloud':
            run(['yt-dlp', '--no-warnings', '-q', '-f', 'bestaudio', '-o', base + '.%(ext)s', 'https://api.soundcloud.com/tracks/' + site['key'].split(':')[1]])
            got = [f for f in glob.glob(base + '.*') if not f.endswith(('.wav', '.npy', '.none'))]
            if got: to_wav(got[0], dst_wav); os.remove(got[0]); return src_done(dst_wav, 'soundcloud', why)
    except Exception:
        if local and local.startswith('//'):
            return None        # the Mac asleep / off the network: try again next run, don't remember it
    open(dst_wav + '.none', 'w').write(why)
    return None


def show_audio(rec, d):
    wav = os.path.join(d, 'show.wav')
    if os.path.exists(wav) or os.path.exists(wav[:-4] + '.npy'): return wav   # feats_cached reads the .npy
    local = sorted(glob.glob(f"{SHOWS_DIR}/Modem_{rec['number']:03d}_*.mp3"))
    if local:
        to_wav(local[0], wav); return wav
    sc = (rec.get('soundcloud') or {}).get('track')
    if not sc: return None
    run(['yt-dlp', '--no-warnings', '-q', '-f', 'bestaudio', '-o', os.path.join(d, 'show.%(ext)s'), sc])
    got = [f for f in glob.glob(os.path.join(d, 'show.*')) if not f.endswith(('.wav', '.npy'))]
    to_wav(got[0], wav); os.remove(got[0])
    return wav


# ---------------------------------------------------------------- one show
def build(args):
    rec, by_key, work, pl = args
    slug = rec['slug']; d = os.path.join(work, slug); os.makedirs(d, exist_ok=True)
    out = os.path.join(d, 'result.json')
    if os.path.exists(out): return slug, 'cached'
    t0 = time.time()
    try:
        site = site_tracks(rec, by_key)
        pairs = pair(pl, site) if pl else {}
        if pl and (len(site) < 5 or len(pairs) >= 0.3 * len(site)):
            items = [dict(it) for it in pl]
            for i, j in pairs.items(): items[i]['site'] = site[j]
            source = 'playlist'
        else:                                 # no playlist, or one that doesn't fit this show's page
            items = [{'title': s['title'], 'artist': s['artist'], 'duration': s.get('duration'), 'path': None, 'site': s} for s in site]
            source = 'page'
        wav = show_audio(rec, d)
        if not wav: return slug, 'no show audio'
        show = Show(feats_cached(wav)); N = len(show.F); length = N / FPS
        L = int(TPL * FPS)
        cands, tf = [], []
        for k, it in enumerate(items):
            w = os.path.join(d, f'i{k:02d}.wav')
            it['audio'] = get_audio(w, it.get('path'), it.get('site'))
            if not os.path.exists(w) and not os.path.exists(w[:-4] + '.npy'): cands.append([]); tf.append(None); continue
            F = feats_cached(w); dur = len(F) / FPS; tf.append(F)
            it['duration'] = it.get('duration') or dur
            best = {}
            for tau in list(np.arange(1.0, max(1.5, dur - TPL), 15.0))[:12]:
                a = int(tau * FPS); T = F[a: a + L]
                if len(T) < L // 2: continue
                for pos, sc in peaks(show.ncc(T), 4, int(10 * FPS)):
                    s = pos / FPS - tau; key = round(s)
                    if key not in best or sc > best[key][1]: best[key] = (s, sc, tau)
            cands.append(sorted(best.values(), key=lambda z: -z[1])[:8])
        # best chain in tracklist order
        n = len(items)
        C = [(i, c[0], c[1]) for i in range(n) for c in cands[i] if c[1] > 0.25]
        bv, prev = [0.0] * len(C), [None] * len(C)
        for a, (i, s, sc) in enumerate(C):
            bv[a] = sc - SKIP * i
            for b in range(a):
                j, s2, _ = C[b]
                if j < i and s2 + MIN_GAP <= s:
                    v = bv[b] + sc - SKIP * (i - j - 1)
                    if v > bv[a]: bv[a], prev[a] = v, b
        chosen = {}
        if C:
            a = max(range(len(C)), key=lambda a: bv[a] - SKIP * (n - 1 - C[a][0]))
            while a is not None: chosen[C[a][0]] = C[a]; a = prev[a]
        # what part of each placed track is heard
        rows = []
        for i, it in enumerate(items):
            row = {'title': it['title'], 'artist': it['artist'], 'key': (it.get('site') or {}).get('key'), 'audio': it.get('audio'),
                   'duration': round(it['duration'], 1) if it.get('duration') else None}
            if i in chosen and chosen[i][2] > 0.35:
                _, s, sc = chosen[i]; F = tf[i]; dur = len(F) / FPS; h = []
                for a in np.arange(0, max(0.1, dur - 6), 3.0):
                    fa, sa, w = int(a * FPS), int((s + a) * FPS), int(6 * FPS)
                    if sa < 0 or sa + w >= N: h.append(0); continue
                    T = F[fa: fa + w] - F[fa: fa + w].mean(); W = show.F[sa: sa + len(T)] - show.F[sa: sa + len(T)].mean()
                    h.append(float((T * W).sum() / (np.linalg.norm(T) * np.linalg.norm(W) + 1e-9)))
                h = np.array(h); on = np.where(h > 0.35)[0]
                if sc < 0.6 and (h > 0.35).mean() < 0.25:
                    row['weak'] = round(sc, 3); rows.append(row); continue
                row.update(start=round(s, 2), entry=round(s + (on[0] * 3.0 if len(on) else 0), 2),
                           exit=round(s + (on[-1] * 3.0 + 6 if len(on) else dur), 2), score=round(sc, 3))
            rows.append(row)
        place_gaps(rows, length)
        res = {'slug': slug, 'number': rec['number'], 'source': source, 'length': round(length, 1), 'rows': rows,
               'placed': sum(1 for r in rows if 'entry' in r), 'seconds': round(time.time() - t0)}
        json.dump(res, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
        for f in glob.glob(os.path.join(d, 'i*.wav')) + [os.path.join(d, 'show.wav')]:
            if os.path.exists(f): os.remove(f)                # keep the .npy fingerprints, drop the audio
        return slug, f"{res['placed']}/{len(rows)} placed ({source}), {res['seconds']}s"
    except Exception as e:
        import traceback
        return slug, 'ERROR ' + ''.join(traceback.format_exception_only(type(e), e)).strip()[:300]


def place_gaps(rows, length):
    """unplaced tracks: spread over the gap between placed neighbours, by known length"""
    t = [r.get('entry') for r in rows]
    i = 0
    while i < len(rows):
        if t[i] is not None: i += 1; continue
        j = i
        while j < len(rows) and t[j] is None: j += 1
        a = rows[i - 1]['exit'] if i > 0 else 0.0
        b = t[j] if j < len(rows) else length
        a = min(a, b)              # a crossfade can end the previous track after the next starts
        lens = [rows[k].get('duration') or 0 for k in range(i, j)]
        tot = sum(lens)
        at, scale = a, (min(1.0, (b - a) / tot) if tot else 1.0)
        for k in range(i, j):
            t[k] = at
            at += (lens[k - i] * scale) if tot else (b - a) / (j - i)
            rows[k]['entry'] = round(t[k], 2); rows[k]['exit'] = round(at, 2); rows[k]['approx'] = True
        i = j


def site_rows(r):
    """the rows worth showing on the site, with estimates recomputed for them:
    - nothing could be timed at all -> no tracklist (every time would be a guess)
    - a playlist much longer than its show (>1.2x: extra candidates that weren't played)
      -> its tracks that matched nothing and aren't on the show page are left out"""
    rows = [dict(x) for x in r['rows']]
    if not any('start' in x for x in rows):
        return []
    total = sum(x.get('duration') or 0 for x in rows)
    if r['source'] == 'playlist' and total > 1.2 * r['length']:
        rows = [x for x in rows if 'start' in x or x.get('key')]
    for x in rows:
        if 'start' not in x:
            for k in ('entry', 'exit', 'approx'): x.pop(k, None)
    # "first heard" can land after the next track already started (a long file of which
    # only a bit was played): then show where its match begins instead
    timed = [x for x in rows if 'start' in x]
    for x, nxt in zip(timed, timed[1:]):
        if x['entry'] > nxt['entry'] - 1:
            x['entry'] = x['start']
    place_gaps(rows, r['length'])
    return rows


def site_json(work, out_path):
    """all result.json files -> the site's show-timestamps.json. Shows the show builder
    timed from its Mix tab ("source": "builder", scripts/tracklists/draft-timestamps.js)
    are exact, so they're kept as they are and never replaced by a match."""
    shows = {}
    try:
        old = json.load(open(out_path, encoding='utf-8')).get('shows', {})
    except Exception:
        old = {}
    builder = {slug: e for slug, e in old.items() if e.get('source') == 'builder'}
    for f in sorted(glob.glob(os.path.join(work, '*', 'result.json'))):
        r = json.load(open(f, encoding='utf-8'))
        tr = []
        rows = site_rows(r)
        if not rows: continue
        for row in rows:
            x = {'t': round(row['entry'], 1)}
            if row.get('key'): x['key'] = row['key']
            else: x['title'] = row['title']; x['artist'] = row['artist']
            if row.get('approx'): x['approx'] = True
            tr.append(x)
        shows[r['slug']] = {'source': 'audio-match', 'tracks': tr}
    shows.update(builder)
    json.dump({'version': 1, 'shows': shows}, open(out_path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    # Matej's hand-set start times (show builder's Tracklist tab) go back on top
    repo_file = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'src', 'assets', 'show-timestamps.json'))
    if os.path.abspath(out_path) == repo_file:
        r = subprocess.run(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'apply-timestamp-edits.js')], capture_output=True, text=True)
        print((r.stdout or r.stderr).strip())
    return len(shows)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('shows'); ap.add_argument('--jobs', type=int, default=3)
    ap.add_argument('--work', default=WORK); ap.add_argument('--site-json')
    a = ap.parse_args()
    arch = json.load(open(ARCHIVE, encoding='utf-8'))
    by_key = {t['key']: t for t in arch['tracks']}
    recs = [r for r in arch['records'] if r.get('type') == 'show' and r.get('number')]
    if a.shows != 'all':
        want = set()
        for part in a.shows.split(','):
            lo, _, hi = part.partition('-'); want |= set(range(int(lo), int(hi or lo) + 1))
        recs = [r for r in recs if r['number'] in want]
    recs.sort(key=lambda r: -r['number'])
    pls = playlists()        # parsed once here; each worker only gets its show's playlist
    print(f'{len(recs)} shows, {a.jobs} at a time', flush=True)
    with Pool(a.jobs) as p:
        for slug, msg in p.imap_unordered(build, [(r, by_key, a.work, pls.get(r['number'])) for r in recs]):
            print(time.strftime('%H:%M:%S'), slug, msg, flush=True)
    if a.site_json:
        print('site json:', site_json(a.work, a.site_json), 'shows')
