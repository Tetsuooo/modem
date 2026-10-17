# modem show builder

The local tool for putting a modem show together and getting it onto the site:
scan new music → pick and order tracks → download, mix, make the cover → generate
the tracklist HTML for radioštudent → publish the show's page on the site. It also
holds the site-maintenance tools: SoundCloud links for Bandcamp tracks, and the
doubled-tag finder.

Runs on your own computer only (nothing here is public). Last big update: 2026-10-17.

---

## Starting it

- Double-click **`show-builder\start.bat`** — opens a console window (the server)
  and the page at <http://localhost:8090>. Or from the repo folder: `npm run showbuilder`.
- To restart (needed after pulling new code): close the console window, run `start.bat` again.
- Needs Node.js, plus Python for the "Download selected" button (`modem_download.py`).

### Getting the latest version onto another machine (e.g. the Surface Pro)

1. Close the show builder's console window on that machine.
2. In the repo folder: `git pull` (or GitHub Desktop → Pull).
3. If `package.json` changed: `npm install`.
4. Start it again with `start.bat`.

The page may need a hard refresh (Ctrl+F5) the first time.

---

## The tabs

| Tab | What it's for |
|---|---|
| **Scan** | SoundCloud reposts + Bandcamp wishlist/library from the last 14 days. Tick what you want. |
| **Download & Arrange** | "Your show": order, artist/label names, headings, download, play. Each Bandcamp track has a **SoundCloud** line (see below). |
| **Publish & Edit** | Show #, **air date**, generate the radioštudent HTML, preview, **publish to the site**. |
| **Mix** | Timeline mix + export (.wav/.mp3). |
| **Covers** | Cover generator. **Export PNG** also keeps a copy for the site. |
| **SoundCloud links** | The backlog: every Bandcamp track from past shows that could stream from SoundCloud. |
| **Tags** | Find and merge doubled artist/label tags; fix one release's tags. |
| **History** | Past shows archived by "Start fresh". |

---

## Publishing a show (since 2026-10-17)

**The site's page for a new show is built straight from your draft** — the radioštudent
page is no longer read. The show builder is the single source of truth: tweak the show
*here*, then re-generate and re-paste the HTML into radioštudent so both match.

1. Build the show as usual (Scan → Arrange → Mix → Covers).
2. **Covers → Export PNG.** This is the cover the site will use. (Set the Show # first,
   so the copy is filed under the right show.)
3. **Publish & Edit:** check **Show #** and **Air date** (filled in from the two-week
   schedule — 249 aired 12. 10. 2026 — change it if the show is off-schedule).
4. **Generate HTML** → copy → paste into radioštudent (for the radio's own page).
5. **Run publish pipeline.** Doesn't need the radioštudent page to be live. It:
   - builds the show's record from the draft (`scripts/add-show-from-draft.js`),
   - carries the SoundCloud links you picked in Arrange into `approvals.json`,
   - rebuilds the track index, applies all SoundCloud links and tag edits,
   - rebuilds the site (`docs/`), then shows a summary of what changed.
6. **Confirm & push** — commits everything and pushes. The site updates after that.

Good to know:
- **Compare with radioštudent** (optional): if the show is already up on radioštudent,
  lists anything that differs from your draft — a track dropped, two swapped, a heading
  retyped. It only reports; fix the draft or re-paste.
- If you changed the draft after copying the HTML, the publish log says so — re-generate
  and re-paste.
- No cover exported? The site takes the cover from radioštudent if the page is already up
  there, otherwise the show has none (the log warns). Export one and publish again.
- The broadcast mp3 and the full-show SoundCloud upload only exist after the show airs —
  the automatic GitHub update (Monday/Tuesday mornings) fills them in, as before.
- Publishing a show number that's already on the site *from before* (scraped from
  radioštudent) asks you to confirm before replacing it — a typo can't overwrite an old show.
- Re-publishing a show built here simply rebuilds it (e.g. after fixing a tag).
- Old shows (up to 249) are untouched; they keep coming from their radioštudent pages.

---

## SoundCloud links

A Bandcamp track that has a SoundCloud upload linked **streams from SoundCloud** on the site
(easier/faster playback); its credit and link still point to Bandcamp.

### While building a show (Arrange)

Each Bandcamp track has a **SoundCloud** line:
- **🔗 find** — searches SoundCloud (the artist's/label's own account first). Each
  candidate shows duration difference (green = within 4 s), a ▶ preview and **use this**.
- **search** box — your own search; **paste** box — a SoundCloud URL or track id you found.
- **none — keep Bandcamp** — record that there's no SoundCloud version.
- A track already linked in an earlier show is picked up automatically.

Sidebar **🔗 Find links** does all of them at once: exact matches (same title, duration
within 4 s, by the artist or the artist's/label's own account) are linked automatically
(marked **auto** — worth a glance), the rest are left for you to review.

The picks are saved in the draft (so they travel with Sync) and go into
`scripts/approvals.json` when you run the publish pipeline.

### The backlog (SoundCloud links tab)

Every Bandcamp track from past shows, queued: **to review** → **decided** → **no match**.
Keys: `1`–`5` pick a candidate, `0`/`n` none, `←` `→` move. There's a search box per track,
and a paste box. **⟲ find new matches** runs the slow batch search for tracks added since
the last one (minutes; runs in the background).

**✔ save** writes your decisions to `scripts/approvals.json` only. **They reach the site
with your next publish** (the pipeline applies them). Saving also records the airtight
automatic matches in `approvals.json`, so they're the same on every machine.

---

## Tags (doubled artist/label tags)

- **Merge duplicates**: near-identical spellings found automatically (case, spacing,
  invisible characters, accents), plus looser "possible" guesses (suffixes like
  "Records", one-letter typos). Click the spelling to keep (green), **merge**. Or
  **keep separate** to hide a pair (remembered in this browser only).
- Build a merge by hand from the tag list; undo any active merge.
- **Edit a release's tags**: find a release, change its artist / labels.

**✔ save** writes `src/assets/overrides.json` only. **They reach the site with your next
publish.** If you *undid* something since the last publish (removed a merge, reset an
edit), that publish also rebuilds the site's data from the source pages first, so the old
spelling comes back — protected so nothing gets lost (see "Technical notes").

Same file format as the site's own `/admin` page, so either can be used.

---

## Two machines: what travels how

| What | Where it lives | Gets to the other machine by |
|---|---|---|
| The code | git | `git pull` (see "Getting the latest version") |
| Current show (tracks, order, names, SoundCloud picks, show #, air date) | `data/shared-draft.json` | **Sync** |
| Used tracks, past-shows history | `data/used-tracks.json`, `data/show-history.json` | **Sync** |
| SoundCloud decisions (backlog tab) | `scripts/approvals.json` | your next **publish** (then Sync/pull on the other one) |
| Tag merges/edits | `src/assets/overrides.json` | your next **publish** |
| Downloads, mix, cover layers, exported cover | `downloads/`, `data/current-draft.json` | not synced — machine-local |
| SoundCloud search cache, candidate list | `scripts/.cache/`, `scripts/sc-match-candidates.json` | not synced — rebuilt per machine |

**Sync** never fails on unsaved-to-the-site decisions: if both machines changed
`approvals.json`/`overrides.json`, Sync merges them entry by entry and keeps this machine's
edits waiting for its next publish. Sync stops (with an explanation) only if this machine
has a publish run that wasn't pushed — finish it with **Confirm & push** first.

**Nothing reaches the site until you publish** (Run publish pipeline → Confirm & push), or
a manual `git push`. (Exception to know about: if decisions have been pushed, the automatic
GitHub update applies them too when it adds a new show.)

---

## Safety rails (why a publish might refuse)

- **"uncommitted changes unrelated to a normal publish run"** — the repo has changed files
  the pipeline doesn't expect (e.g. code you're editing). Commit or discard them first.
  The files it does expect: the archive, used-tracks, covers, `docs/`, `approvals.json`,
  `overrides.json`, `builder-shows.json`.
- **"diff mentions a year-end list"** — the archive change touches a best-of list, which a
  show publish shouldn't. Look at `git diff -- src/assets/modem-archive.json` before pushing.
- **"modem-N is already on the site (scraped from radioštudent)"** — confirm only if you
  really mean to replace that old show with your draft.

---

## Technical notes

### Publish pipeline (`/publish-run`, in order)
1. `scripts/add-show-from-draft.js --show N --date "D. M. YYYY"` — record from the draft,
   using the scraper's own parser on the generated HTML (same shape as every scraped show).
   Marks it `origin: "show-builder"` and keeps an as-built copy in
   `src/assets/builder-shows.json`. Cover: exported PNG
   (`downloads/_show_covers/modem-N.png`) → `src/assets/modem_covers/modemNN.webp`.
2. *(only if a tag edit was undone since the last publish)* `reparse-guard.js --snapshot`
   → `scrape-modem.js --reparse` → `reparse-guard.js --restore`.
3. `apply-draft-sc.js --show N` — draft SoundCloud picks → `approvals.json`.
4. `build-track-index.js` → `apply-sc-matches.js` → `apply-overrides.js` → webpack.

### Why the re-derive needs a guard
`scrape-modem.js --reparse` rebuilds every record from cached radioštudent pages. Some
things aren't on those pages: tags that came from a show-builder draft (e.g. 248, 249),
backfilled mp3/SoundCloud, and the segment-marker fixes for 195/224/244. `reparse-guard.js`
snapshots them first and puts them back after. Shows built here aren't rebuilt from a page
at all — `--reparse` uses their as-built copy, and a normal scrape never touches them.
Limitation: undoing a merge doesn't restore the old spelling on a show whose tags came
from a draft before 2026-10-17 (248, 249) — its original isn't on any page.

### Files
- `scripts/sc-search.js` — SoundCloud lookup/scoring, shared by `find-sc-matches.js` (batch)
  and the show builder (one track at a time). Cache in `scripts/.cache/`.
- `show-builder/sc-links.js` — `/sc/*` routes. `tag-tools.js` — `/tags/*`.
  `compare-live.js` — "Compare with radioštudent". `jobs.js` — background job queue.
  `archive-cache.js` — the parsed archive, cached.
- `show-builder/public/sc-links.js`, `tags.js`, `tools.css` — the new tabs' front end.
- `show-builder/sync.js` — Sync (now also merges the two decision files, carries the air date).

### Older tools still around
The main dev server (`node server.js`, :8085) still has `/match-review` and `/admin`. They
work, but its `/save-overrides` does an *unguarded* re-derive (loses 248/249's tags) — use
the Tags tab here instead.

### 2026-10-17 change log
- SoundCloud links: per-track picker + "Find links" in Arrange; backlog tab with free-text
  search; decisions saved to `approvals.json`, applied at publish.
- Tags tab (merge duplicates / edit a release), saved to `overrides.json`, applied at publish.
- Publishing builds a new show from the draft instead of scraping radioštudent; air date
  field; exported cover used directly; "Compare with radioštudent"; replace-confirm for old shows.
- Sync merges `approvals.json`/`overrides.json` and carries the air date; explains instead of
  failing on an unpushed publish.
- `reparse-guard.js` protects draft tags, backfilled audio and segment fixes in a re-derive.
