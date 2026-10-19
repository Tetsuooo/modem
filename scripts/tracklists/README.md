# Live tracklists (timestamps for every show)

Under each show's player the site shows a **live tracklist**:
- a "tracklist ▾" bar that opens every track with its start time, cover and bandcamp /
  soundcloud links; tapping a row jumps the show there
- once the show plays, a "now playing" row above it that follows along

Code: `setupTracklist()` in `src/archive.html`.

The **floating player** has a slim version while it plays a whole show: one "now playing" line
under the date, whose ▾ opens a short one-line-per-track list. In the phone's mini bar, only
the current track shows, in place of the date. Code: `tlSetup()` in `src/index.html`.

Both read `src/assets/show-timestamps.json` through `window.modemTimestamps()` (fetched once).

## The data

```json
{ "version": 1, "shows": { "modem-249": { "source": "audio-match", "tracks": [
  { "t": 42.1, "key": "bc:1054807429:3554734681" },
  { "t": 1436.0, "title": "Individual Drops", "artist": "Ice_Eyes" },
  { "t": 2837.6, "key": "sc:2403681711", "approx": true }
] } } }
```

- `t`: seconds into the show's **SoundCloud upload** (what the site's player plays).
- `key`: a track in `modem-archive.json`'s track index, so the row gets its art and links.
  A track that was played but isn't on the show page has `title` + `artist` instead.
- `approx`: the matching couldn't place it, so it's spread over the gap between its
  neighbours by length. Shown with a "~".

## How the timestamps were made: `build_tracklists.py`

For each show:

1. **Tracklist**: the iTunes playlist `modemN` from Matej's library export
   (`Library.xml`), which is what was actually played, in order, with lengths. If there's no
   playlist, it uses the show page's embeds in page order. `modem248` is ignored; it's a dump
   of unused tracks. So is any playlist that hardly matches its show's page.
2. **Linking**: each playlist entry is paired with the page's track (similar title/artist,
   in order, plus clear matches in any order), which gives the site's art and links.
3. **Audio**:
   - The show comes from `D:/MODEM/oddaje/Modem_NNN_*.mp3` (verified identical to the
     SoundCloud upload, offset 0.00 s), else the SoundCloud upload via yt-dlp.
   - Each track comes from its own file: on `D:/HEWZ muska` (the playlist's path), else on
     **the Mac** over the network (`//192.168.100.6`, macOS Sierra with File Sharing (SMB) on,
     shares `Music` and `matejmihevc`; the library's `/Users/matejmihevc/...` paths), else on D:
     found by file name. If there's no file, it uses the Bandcamp stream (embed page, fetched
     with curl; Bandcamp shows Python a bot check) or the SoundCloud stream (yt-dlp).
     `MODEM_MAC=''` skips the Mac. A failed read from the Mac (asleep) is retried next run.
     2429 of 2598 playlist tracks missing from D: were found on the Mac (2026-10-19).
4. **Matching**: fingerprints are log band-energy spectrograms (32 bands, ~21 frames/s).
   12 s pieces of each track are slid along the whole show (normalised cross-correlation),
   and the best chain in tracklist order is kept. Then it measures which part of each track
   is heard, which catches tracks cut short or mixed in late.

Safeguards:
- A moved file is only found by name when its folder names the artist or album, or the name is
  unique and distinctive. "Track 3.mp3" exists many times over.
- A weak match (score < 0.6) that the rest of the track doesn't confirm is dropped and becomes
  an estimate (`weak` in result.json).
- Estimates never run backwards.
- A cached fingerprint is reused only for the same file or stream (`.src`).

Trial (6 shows, 2017–2026): 145 of 172 tracks (84%) timed to the second; the rest are
estimated. Most of the estimated ones were in the Mac's own iTunes Media folder (not on this PC)
and have no stream.

```
python build_tracklists.py all --jobs 3 --site-json ../../src/assets/show-timestamps.json
python build_tracklists.py 120-130            # a range; cached shows are skipped
```

The work folder (`E:/ART/websites/modem-tracklists-work`) keeps each show's `result.json` (per
track: start, where it's first heard, score, audio source) and the fingerprints (`.npy`, a few
GB). Delete a show's `result.json` to redo it. Needs Python 3 with numpy + scipy, ffmpeg, curl
and yt-dlp.

## Full run results (2026-10-19, with the Mac)

- 249 shows processed, no errors. **243 shows have a tracklist: 4630 of 5004 tracks timed
  exactly (92.5%)**, 374 estimated ("~"). Of the shows, 96 are 100% exact and 72 are 90–99%.
- No tracklist:
  - 100 and 200 (Bag of Toys compilations, no single recording)
  - 2 and 6 (no tracks on their pages)
  - 4 and 10 (nothing could be timed)
- What goes on the site is filtered by `site_rows()`:
  - nothing timed → no tracklist
  - playlists longer than 1.2× their show (unplayed candidates; 22 shows, e.g. 18: 39 → 9 rows)
    lose their tracks that matched nothing and aren't on the page
  - a track's time never passes the next track's
  - estimates are recomputed after all that
- Weakest: 162 (51 short pieces, 23 matched) and the early 2017–2018 shows (fewer files). Shows
  130–140 have no iTunes playlist and use the page order.

## Where we left off (2026-10-19 evening)

- Everything is on the branch `live-tracklist`, **uncommitted and not pushed**: `src/archive.html`,
  `src/index.html`, `src/assets/show-timestamps.json`, and this folder. Matej OK'd the look on a
  phone. Push only when he says so.
- The full run over all 249 shows was still going (log: `E:/ART/websites/modem-tracklists-work/run.log`).
  When it ends:
  1. run `site_json` into `src/assets/show-timestamps.json`
  2. rebuild the preview
  3. look at the weak spots: shows with many estimated tracks, playlists that didn't fit
  4. give Matej a breakdown
- `src/assets/overrides.json` shows as modified from line endings only. Leave it out of commits.
- Open idea: copy the Mac's `~/Music/iTunes/iTunes Media` to this PC and re-run. About 2300
  playlist tracks lived there, which would fill most of the estimated gaps.

## New shows: timed by the show builder

When a show is published from the show builder, `scripts/add-show-from-draft.js` takes each
track's start straight from the draft's **Mix tab** (`draft-timestamps.js`) and writes that
show's entry into `show-timestamps.json` with `"source": "builder"`. No matching is needed.
- **Why it's exact:** the Mix export renders the timeline from 0:00 with every clip at its
  `start` (`renderMixOffline()`), and that export is what goes to SoundCloud.
- **The jingle and muted clips are left out.** A track split into several files starts at its
  first clip.
- **Keys:** each track gets the site's key from the same embed the page gets
  (`bc:<album>:<track>` / `sc:<id>`), plus title/artist for anything without one.
- **No mix, no timestamps:** the Mix tab's clips are machine-local (not synced). Publish from
  the machine where the show was mixed. A draft without a mix logs "no timestamps yet", and the
  show can be matched from the audio later like the old ones.
- **Builder entries are kept:** `build_tracklists.py` (`site_json`) never replaces a
  `"builder"` entry.
- **Publish check:** `show-builder/server.js` counts `show-timestamps.json` as an expected
  change, so a publish run isn't blocked by it.

Check what a draft would produce (read-only):
`node scripts/tracklists/draft-timestamps.js [show-builder/data/current-draft.json]`

Tested 2026-10-19 in a throwaway worktree: a 249 test draft with a jingle and a muted clip gave
23 builder-timed tracks; the other shows were kept; a later `site_json` merge kept it.
