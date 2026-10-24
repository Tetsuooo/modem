# modem show builder

The local tool for putting a modem show together and getting it onto the site:
scan new music → pick and order tracks → download, mix, make the cover → generate
the tracklist HTML for radioštudent → publish the show's page on the site. It also
holds the site-maintenance tools: SoundCloud links for Bandcamp tracks, and the
**Edit site** tab — how every show is tagged, doubled tags, and publishing those edits.

Runs on your own computer only (nothing here is public). Last big update: 2026-10-19.

---

## Where we left off (2026-10-24)

**Fixed: Scan previews showed SoundCloud's big player again.** SoundCloud stopped offering
the plain MP3 stream that the small built-in preview player used; tracks only come as HLS
now (a playlist of short pieces). The builder now plays that through hls.js
(`public/vendor/hls.light.min.js`), so SoundCloud previews in Scan and in the Year-end list
are the small rows again. Bandcamp was never affected. Whole albums / SoundCloud sets that
aren't expanded still open the platform's tracklist player, as before.
- **Before using it:** restart the show builder (`start.bat`). On the Surface: `git pull` +
  restart once it's pushed.
- The website itself is not affected: it plays through SoundCloud's own player (widget),
  which streams HLS by itself — checked the same day.

## Where we left off (2026-10-22)

**New: the Year-end list tab** — building the year's "50 best releases" list. See "Year-end
list" below.
- **Before using it:** restart the show builder (`start.bat`). On the Surface: `git pull` +
  restart (no new packages).
- **2026 is already gathered** on the desktop: 404 releases from the 21 shows of 2026
  (229–249) — 106 LPs, 45 EPs, 12 compilations, and 241 singles (hidden unless you show
  them). Nothing picked yet. The gathered releases travel to the Surface with **Sync**.
- **Gather again** after the year's last shows are on the site (it keeps your picks; cached,
  so a re-gather takes seconds, only new shows are looked up).
- Checked against last year: gathering 2025's shows finds every release on the published
  "best releases of 2025" that was played in a 2025 show (42 of its 49); the other 7 were
  played in January 2026 or never in a show — for those, paste the link ("+ add to the list").

## Where we left off (2026-10-19, late)

**New: the site has a live tracklist under every show** (now playing, start times, jump to
a track; slim version in the floating player). For this tool that means:
- **Tracklist tab** (new): fix track start times by hand while listening. Save → **Publish
  site edits**. See "Tracklist: fixing start times by hand" below.
- **Publishing a show** now also writes its exact track times from the **Mix tab**. Publish
  from the machine where you mixed (the mix isn't synced), and upload the exact export to
  SoundCloud.
- **Before using it:** restart the show builder (`start.bat`) on this PC and `git pull` +
  restart on the Surface. The new tab and the publish steps only exist after a restart.
- How the times were made, and the data: `scripts/tracklists/README.md`.

## Where we left off (2026-10-19)

**New: the Edit site tab** (was "Tags") — see "Edit site" below.
- **Edit a show:** pick any show or year-end list; every heading shows the tags the site
  gives it (checked against the live site: all 270 shows and lists match exactly). Add /
  rename / remove a tag, ⇄ flips it between artist and label, **credits** fixes one
  track's own artist/labels. Same data the pencils on the site's local preview wrote —
  that preview (`node server.js` + `/admin`) isn't needed any more.
- **Publish site edits:** saved tag edits and SoundCloud-link decisions go live without
  waiting for a show: rebuild → a list of what changes, in words → **preview on this
  computer** → **Push to the live site** (or **discard this build**).
- Fixed on the way: resetting ONE heading of a show with other edited headings now comes
  back on publish; a track's search text is rebuilt after edits (an artist fixed in an
  edit was not searchable under the new name; and the text came out differently after an
  undo); a heading edited to have no label clears its tracks' labels in the same build.

**State (end of 2026-10-19):** pushed to GitHub (`f7de956` code, then these notes).
- **Desktop:** up to date; the show builder running there already has the new tab.
- **Surface:** close the show builder → `git pull` → `start.bat` (no `npm install` needed —
  no new packages). Ctrl+F5 in the browser if the tab still says "Tags".
- **The live site did not change** — this was tool code only (`show-builder/`, `scripts/`;
  GitHub only rebuilds the site for `src/**`). The two pipeline fixes in
  `scripts/apply-overrides.js` reach the site's data with the next rebuild: your next
  Publish site edits / show publish, or the automatic Monday/Tuesday update (it runs the
  scripts from the repo). Expected effect then: modem-249's "Ein" track searchable as
  "Ein" (was "Ein (@ein.garden)"), nothing else visible.
- Nothing is waiting to be published (`overrides.json` shows as modified in git only
  because a save rewrote it with different line endings — same content).

**First real use (suggested):** 249 → heading 3 "Log Planter" → the track's **credits** →
artist "Log Planter" (it says "Musique Muscle", the uploading account) → ✔ save →
Publish site edits → preview → Push. Then search the live site for "Log Planter".

**Not done / ideas**
- Tags that aren't under any heading (e.g. 247's "Minoyimn", most old shows have some)
  are only listed, not editable — they'd need a new kind of override.
- The heading TEXT (e.g. 249's "Log Planter" vs label-first) isn't editable here — the
  site shows tags instead of that text, so it only matters for radioštudent / the artist
  list. Fix those in the draft before generating.
- The automatic GitHub update rebuilds without this computer's `scripts/.cache`, so it
  drops some SoundCloud playback titles that a rebuild here adds back (seen as "other
  track details" in a publish summary). Harmless; older than this tab.

---

## Where we left off (2026-10-17)

**State**
- Everything below is committed and pushed (commits `7429c81`, `d4282b6`, `2bc989f`).
  Nothing on the live site has changed yet — the first show published the new way will be
  the first change.
- **Desktop:** working copy clean. Restart the show builder before using it (the copy that
  was running still had the old code).
- **Surface:** `git pull`, then restart the show builder.
- Your 3 SoundCloud picks from the review tab are committed; they show up on the site with
  the next publish.
- 16 new automatic SoundCloud matches were found on the desktop (tracks added since July).
  They get recorded in `approvals.json` the next time you press **save** in the SoundCloud
  links tab **on the desktop** — the candidate list they come from only exists there.

**Checklist for the first real publish (show 250)**
1. Both machines: pulled + show builder restarted.
2. Build the show. **Covers → Export PNG with the Show # already set.**
3. Publish & Edit: check **Show #** and **Air date** (250 → 26. 10. 2026 by the schedule).
4. Generate HTML → paste into radioštudent. Optional: **Compare with radioštudent**.
5. **Run publish pipeline** → read the summary. Expect: `src/assets/modem-archive.json`,
   `docs/…`, `src/assets/builder-shows.json`, the new cover `modem_covers/modem250.webp`,
   possibly `scripts/approvals.json`.
6. **Confirm & push**, then look at the show's page on the site.
Nothing is live until step 6 — if anything looks off before that, just stop.

**Open items / ideas**
- **modem-249 doesn't match its saved draft.** The draft has a track ("Mifu") and two
  heading spellings ("4h4, vaber66", "Ein (@ein.garden)") that the radioštudent page — and
  so the site — doesn't, and two tracks (seaketa / хмора) in the other order. If the draft
  is the right version, 249 can be re-published from the show builder (it asks before
  replacing the old page). That draft isn't the one currently open, so ask for help.
- ~~**A "push site edits" button**~~ — done 2026-10-19 (Edit site → Publish site edits).
- **Surface backlog:** the SoundCloud links tab there has no (or a July) candidate list.
  Run **⟲ find new matches** once on the Surface (several minutes) to review the backlog there.
- The old preview-server tools (`localhost:8085/match-review`, `/admin`) could be retired now
  that the show builder has both (and, since 2026-10-19, the per-heading editor too).
- `scripts/apply-draft-tags.js` is no longer used by the publish pipeline (kept for the old
  scrape route, e.g. if a show is ever published the old way again).

---

## Starting it

- Double-click **`show-builder\start.bat`** — opens a console window (the server)
  and the page at <http://localhost:8090>. Or from the repo folder: `npm run showbuilder`.
- To restart (needed after pulling new code): run `start.bat` again. Since 2026-10-24 it
  closes a show builder that's still running first (its window, or whatever holds port
  8090). Before that, a still-open server window kept the port, the new one failed to start
  and the page was the OLD version — an update that "did nothing".
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
| **Edit site** | How each show is tagged (per heading, per track); merge doubled tags; fix one release's tags; **Publish site edits**. |
| **Tracklist** | Set where tracks start in a show (the site's live tracklist), while listening to it. See below. |
| **Year-end list** | The year's 50 best releases: every LP / EP played in the year's shows, listen, put in or out, rank, cut at 50, HTML for radioštudent. See below. |
| **History** | Past shows archived by "Start fresh". |

### Tracklist: fixing start times by hand

Every show page has a live tracklist (`scripts/tracklists/README.md`). Most start times were
found by matching the audio; the ones it couldn't find are estimated and marked **~**. Shows
published from the Mix tab are exact already.

1. **Tracklist** tab → pick a show. The list puts the shows with the most estimates first.
2. **▶ play**. It's the show's own SoundCloud upload, the same audio the site plays. Click the
   timeline to jump. Markers: white = matched, orange = estimated, green = set by you.
3. For a track:
   - **now** sets its start to where the show is playing (press it as the track begins)
   - or type the time (`12:34.5`, Enter)
   - **−1 / +1** nudge it
   - **▶** plays from just before it
   - **not played** hides it on the site (for playlists that held tracks that weren't
     actually in the show)
   - **↺** takes your fix back
4. **Save fixes**, then **Publish site edits** (Edit site tab) to put them online, like tag
   edits.

The fixes are saved in `src/assets/overrides.json` → `timeEdits` and travel with **Sync** like
tag edits. A publish applies them (`scripts/tracklists/apply-timestamp-edits.js`), and a later
matching run never loses them.

### Year-end list (the 50 best releases)

1. **Year-end list** tab → pick the year → **Gather** (the first time a few minutes: it
   reads every show of the year from the site's archive and looks each release up on
   Bandcamp / SoundCloud; later only what's new). It lists every LP, EP and compilation
   played in those shows. Singles are kept but hidden (the **singles** button shows them).
2. **Left: the releases.** Each shows its type, tracks, length, release month (⚠ if it came
   out before this year), the shows it was played in (**♪ #241 ×3** = three of its tracks
   in modem 241). **bc ↗** / **sc ↗** (on every release, in the list too) opens its
   Bandcamp / SoundCloud page in a new tab — both when a show played it from both.
   **Sort** by most played, played most recently, release date
   (newest or oldest first; no date = last), artist, title or label (A–Z), or search.
   **group by artist** (on by default) keeps each artist's releases together, under their
   name, in the place of their best-placed release. **hide released before 2026** hides
   last year's (and older) releases; one with no known date stays. These choices are
   remembered on this computer. **same artist…** lists names that are one artist, one artist
   per line, names separated by `=` (e.g. `Computer man = Computer doctor = Dj-c`) — their
   releases are grouped together, for every year; travels with Sync.
   **▶** (or the cover) plays it through, track by track, in the same player as
   Arrange; the tracks played in shows are marked; click a track to jump to it, or its **↗**
   to open that track's page.
   **+ list** puts it in (at the bottom of the list), **✕** puts it out; the to do / in the
   list / out / all buttons switch between them.
3. **Right: the list.** Drag to rank (or ⤒ ↑ ↓ ⤓). The first 50 make it; the dashed line is
   the cut, everything below it is dimmed. **✎** fixes the artist / title / label as they go
   on the list (e.g. a label the Bandcamp page doesn't name — empty label = self-released).
   **✕** takes it back out.
4. **A release that wasn't in a show:** paste its Bandcamp or SoundCloud link above the
   releases → **+ add to the list**.
5. **Generate HTML** → the first 50, alphabetical by artist, in the shape of the published
   lists ("★*ﾟ50 best releases in alphabetical order *★", then per release "Artist - Title
   (Label)" with links and its player) → copy → paste into radioštudent. Also as a plain list.
   As on every list so far: a label that is the artist (the same name, a "same artist" name,
   or one of a collaboration's names) is written **(self-released)** — plain, no link; a
   compilation is **V/A - Title (Label)** ("V/A" without a link; its label the one tagged,
   else the page it's on). The tab shows them the same way; a name fixed with ✎ wins.
   **Links** (artist and label, like the published lists — mostly SoundCloud profiles), for
   each name the first of: the link used for it on an earlier list (any of a "same artist"'s
   names) → the SoundCloud profile that uploaded the release's tracks, when it has that name
   (from the SoundCloud versions approved here, `scripts/approvals.json`) → the SoundCloud
   account in the Bandcamp page's links box (the artist's own page / the label's page) → a
   SoundCloud account with exactly that name, when there's only one → the Bandcamp page.
   Otherwise no link. ✎ has "artist link" / "label link" fields to set one yourself.
   Checked against the 2025 list (knowing only the lists before it): 53 of 75 the same as
   Matej's, 6 an equal alternative, 8 left empty (several SoundCloud accounts with that name),
   8 extra. The first Generate HTML of a year looks names up (~15 s), then it's cached.
   **Tag pills:** the site makes them from each line itself (src/archive.html: the artist
   before " - ", the label in the closing brackets; none for "self-released"), so the list
   gets them as soon as it's on the site — nothing to tag by hand for the pills.

Everything saves as you go; **Ctrl+Z / Ctrl+Y** undo / redo here (only the list's own
changes while this tab is open). **Sync** carries it to the other machine — newest version
of each year wins, like the draft, so finish on one machine and Sync before switching.

How a release's type is decided: on Bandcamp from its tracks — a **single** is 1 track, or 2
under 15 minutes together; an **LP** has 7+ tracks or runs 30+ minutes; an **EP** is in
between; a **compilation** has tracks by 3+ different artists and none by the release's own
artist (Jonáš Gruska's "Juggler", with guests on some tracks, is an LP; when most titles read
"Artist - Title", like gud serben's "GUD LUCK !!", the part before the dash counts as the
track's artist; a release credited to Various Artists / V/A always can be). On SoundCloud, what the
uploader marked it as (album / EP / single / compilation); a SoundCloud track that isn't on
any album or EP counts as a single. The same release on Bandcamp and SoundCloud becomes one
entry (Bandcamp kept, since the lists embed Bandcamp) — also when SoundCloud has the artist
in the title ("Dj-c - Night of the living liquor store"); releases without a real title
(just "-" or an emoji) are never merged. The label is the one tagged in the shows, else the
Bandcamp account it's on when that isn't the artist's own. Names come without invisible
direction marks (Bandcamp's "Computer man" account has them), so they don't end up in the HTML.

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
   - times every track for the site's **live tracklist** straight from the Mix tab: each
     clip's start = the track's time in the show (`src/assets/show-timestamps.json`, see
     `scripts/tracklists/README.md`),
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
- **Live tracklist times come from the Mix tab**, and the mix lives only on the machine
  where you made it (it isn't synced). Publish from that machine, and upload the exact file
  you exported to SoundCloud. If the timeline changes after you export, publish again so the
  times match. A draft with no mix publishes fine; the log says "no timestamps yet", and
  that show can be timed from the audio later.
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
with your next publish** — **Edit site → Publish site edits**, or a show publish (the
pipeline applies them). Saving also records the airtight automatic matches in
`approvals.json`, so they're the same on every machine.

---

## Edit site (how shows are tagged, doubled tags, publishing)

### Step by step: fixing a show's tags
1. **Edit site** tab → **Edit a show** (it opens on the last show you looked at).
2. Type the show number in the box (e.g. `249`) and press Enter. ◀ ▶ = older / newer.
3. Find the heading. Fix its tags (see "Common fixes" below). Changed headings get a
   yellow **unsaved** badge; **reset to original** undoes a heading.
4. **✔ save** (top of the tab). The badge turns green: **not on the site yet**, and the bar
   at the top says what's waiting ("Saved, not on the site yet: 1 heading · 1 release").
5. **Publish site edits.** A log runs (about a minute; a few minutes if you undid
   something). Then a list: what would change on the site, show by show.
6. **preview on this computer ↗** — the whole site, rebuilt, opened on that show. Check it.
7. **Push to the live site.** It says "Pushed"; the live page updates within a minute or
   two (GitHub Pages). Or **discard this build** if you changed your mind — your saved edits
   stay, nothing went anywhere.

You can fix several shows before publishing — one Publish takes all saved edits.

### Common fixes
| What you see | What to do |
|---|---|
| A label shown as an artist (or the other way round) | **⇄** on that chip |
| Two names stuck in one chip ("kęnåi, IRIGINO") | click the name → rename to the first; type the second in **+ artist** |
| A typo / wrong spelling on one heading | click the name, fix, Enter |
| The same name spelled differently across shows | **Merge duplicates** (fixes it everywhere) instead |
| A missing tag | type it in **+ artist** / **+ label**, Enter — pick the existing spelling from the suggestions |
| A track credited to the uploading account (e.g. 249's Log Planter track says "Musique Muscle") | that track's **credits** → artist |
| An edit you regret | **reset to original** (heading) / **reset to original** in the track's credits |

Rule of thumb: the **heading** chips are what visitors see on the show page; a track's
**credits** are what search and the player use. A heading with one track updates that
track too.

### When something goes wrong
- **"save your changes first"** next to the Publish button — press ✔ save.
- **"A show publish was run but not pushed yet"** — go to Publish & Edit, finish it with
  **Confirm & push**; it takes your saved edits along.
- **"Edits were saved after this run finished"** — press **Publish site edits** again, then push.
- **"the rebuild failed"** — nothing changed on the site. The log shows the step; your
  saved edits are still saved. Ask for help with the log.
- **Sync says the archive is modified** — a Publish site edits build is waiting: push it or
  **discard this build**.
- **A chip you expected isn't on the live page after pushing** — wait two minutes and
  reload with Ctrl+F5 (GitHub Pages caches).

### Edit a show
Pick a show (type its number, e.g. `249`, or a list's name; ◀ ▶ step through). Each
**heading** shows the tags it has on the site — the site shows these chips in place of the
heading text. White = artist, lavender = label.
- **click a name** to rename it · **⇄** switch it between artist and label · **×** remove ·
  type in **+ artist / + label** and Enter to add (suggestions come from existing tags, so
  you don't make a near-duplicate).
- An edit replaces that heading's tags as a whole (`segEdits`). **reset to original**
  drops the edit; the scraped tags come back when you publish.
- Under each heading: its tracks. **credits** fixes that one track's own artist/labels
  (`tagEdits`) — what search and the player show. A heading's edit also fixes its track
  when it has just one.
- Badges: **unsaved** (press ✔ save) · **not on the site yet** (saved, not published) ·
  **edited** (an edit that's live).
- Tags that aren't under any heading are listed at the bottom (the site only shows them in
  the "all tags" line). Not editable yet.
- Year-end lists have no headings — their tracks are listed for **credits**.

### Merge duplicates / Edit a release's tags
- **Merge duplicates**: near-identical spellings found automatically (case, spacing,
  invisible characters, accents), plus looser "possible" guesses (suffixes like
  "Records", one-letter typos). Click the spelling to keep (green), **merge**. Or
  **keep separate** to hide a pair (remembered in this browser only).
- Build a merge by hand from the tag list; undo any active merge.
- **Edit a release's tags**: find a release, change its artist / labels.

### Saving and publishing
**✔ save** writes `src/assets/overrides.json` only. Then either:
- **Publish site edits** (the bar at the top of the tab — it says what's saved but not on
  the site yet): rebuilds the site with your saved edits **and** any SoundCloud-link
  decisions, then lists what would change ("modem-249: heading 10 (artists, labels)", how
  many tracks' credits). **preview on this computer ↗** opens the rebuilt site at
  `localhost:8091` on the show you're editing. **Push to the live site** commits + pushes;
  **discard this build** puts the site files back (your saved edits stay).
- or just wait: a show publish takes all saved edits along.

If you *undid* something since the last publish (removed a merge, reset an edit), the
rebuild first re-derives the site's data from the source pages, so the old spelling comes
back — protected so nothing gets lost (see "Technical notes"). It takes a minute longer.

Publish site edits refuses while a show publish is waiting to be pushed (finish that one —
it takes the edits along), and the push refuses if you saved more edits after the rebuild
(run it again).

Same file format as the site's own `/admin` page and its pencils, so any of them can be used.

---

## Two machines: what travels how

| What | Where it lives | Gets to the other machine by |
|---|---|---|
| The code | git | `git pull` (see "Getting the latest version") |
| Current show (tracks, order, names, SoundCloud picks, show #, air date) | `data/shared-draft.json` | **Sync** |
| Used tracks, past-shows history | `data/used-tracks.json`, `data/show-history.json` | **Sync** |
| Year-end list (releases, picks, order, name fixes) | `data/year-end.json` | **Sync** (newest per year wins) |
| SoundCloud decisions (backlog tab) | `scripts/approvals.json` | **Publish site edits** or your next show publish (then Sync/pull on the other one) |
| Tag merges/edits, heading + track edits | `src/assets/overrides.json` | **Publish site edits** or your next show publish |
| Downloads, mix, cover layers, exported cover | `downloads/`, `data/current-draft.json` | not synced — machine-local |
| SoundCloud search cache, candidate list | `scripts/.cache/`, `scripts/sc-match-candidates.json` | not synced — rebuilt per machine |

**Sync** never fails on unsaved-to-the-site decisions: if both machines changed
`approvals.json`/`overrides.json`, Sync merges them entry by entry and keeps this machine's
edits waiting for its next publish. Sync stops (with an explanation) only if the site's
archive is modified on this machine — a publish run that wasn't pushed (finish it with
**Confirm & push** / **Push to the live site**, or **discard this build**), or a save on the
local website preview's `/admin` (see "Older tools").

**Nothing reaches the site until you publish** (Run publish pipeline → Confirm & push, or
Edit site → Publish site edits → Push to the live site), or a manual `git push`. (Exception to know about: if decisions have been pushed, the automatic
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
- **Publish site edits: "A show publish was run but not pushed yet"** — push (or finish)
  that show first; it takes the saved edits along.
- **"Edits were saved after this run finished"** — the rebuilt site doesn't have them;
  press Publish site edits again, then push.
- (Publish site edits doesn't do the year-end-list check: a tag merge rightly renames a
  tag on a list too. Its review lists every changed show/list by name instead.)

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

**Publish site edits** (`/publish-edits-run`) is the same without steps 1 and 3; same job,
same `/publish-status`, same `/publish-push` (commit message "Site edits … via
show-builder"). `/publish-discard` = `git checkout -- src/assets/modem-archive.json docs`.
Each run ends with a per-show comparison of the committed and rebuilt archive (the review
list) and a fingerprint of the two decision files, which `/publish-push` checks.

`apply-overrides.js` rebuilds every track's `searchText` last (same formula as
`build-track-index.js` + the SoundCloud title/artist `apply-sc-matches.js` appends), so
edited names are searchable and a re-derive gives the same archive as a normal rebuild
(checked: identical). On the 2026-10-19 data this changed one track (modem-249 "Ein").

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
  `site-tools.js` — `/site/*`: a show's headings with their chips (`headingsFor()` mirrors
  `src/archive.html`'s `injectSegTags()` — keep them in step), what's saved but not live,
  and the local preview of `docs/` on :8091 (`PREVIEW_PORT`).
  `compare-live.js` — "Compare with radioštudent". `jobs.js` — background job queue.
  `archive-cache.js` — the parsed archive, cached.
- `show-builder/public/sc-links.js`, `tags.js` (the Edit site tab), `tools.css` — the tabs' front end.
- `show-builder/sync.js` — Sync (now also merges the two decision files, carries the air date,
  and since 2026-10-22 `data/year-end.json`).
- Year-end list: `year-end-gather.js` (the gather job; `--year`, `--fresh`, `--out`),
  `year-end-releases.js` (one Bandcamp / SoundCloud release → a candidate, shared with "add
  a release"), `year-end.js` (`/ye/*` routes, the HTML), `public/yearend.js` (the tab).
  Bandcamp pages come from `scripts/.cache` (shared with the SoundCloud matching and the
  track index); SoundCloud lookups are cached in `data/.cache` (`ye-sc-*`).

### Older tools still around
The main dev server (`node server.js`, :8085 — the local preview of the website) still has
`/match-review` and `/admin` (and the pencils on show pages once logged in there). All work,
but they're for previewing locally; for the real site use the SoundCloud links and Edit
site tabs here.

- Its `/admin` save follows the same rule as the publish pipeline: new merges/edits are just
  applied; only an *undo* re-derives, protected by `reparse-guard.js` (until 2026-10-17 it
  did an unprotected re-derive on every save, which wiped 248/249's tags).
- Unlike the Tags tab, it changes the site's archive on this machine straight away (so the
  preview shows it). Sync will then ask you to either publish or drop that change with
  `git checkout -- src/assets/modem-archive.json docs` — the saved edits themselves stay.
- `scripts/overrides-diff.js` holds the "is this an undo?" check all three places share
  (per heading since 2026-10-19: resetting one heading of a show is an undo too).

---

## Decision log

**2026-10-17 — SoundCloud matching moved into the show builder.** Before: a separate review
page on the website's preview server (`/match-review`). Now: a SoundCloud line per Bandcamp
track in Arrange (+ "Find links"), and the backlog as its own tab with a free-text search.
*Why:* point each track at its SoundCloud version while building the show, and work through
the ~690 unlinked old tracks in the same tool.

**2026-10-17 — Tag tools moved into the show builder.** The `/admin` tag merge + per-release
editor became the Tags tab, same `overrides.json` format. *Why:* find doubled tags in the
same place. While porting: the old editor dropped the `artists` list (collab credits) and
`title` fixes of 178 existing edits when it saved one — the new one keeps them.

**2026-10-17 — New shows are published from the draft, not scraped from radioštudent.**
*Why:* Matej edits shows only in the show builder. Scraping meant waiting for the page to be
live, losing tags whenever radioštudent's own tag fields were empty (the modem-248 incident),
and picking up hand-edits made only there — a check found 249's page and draft had drifted
apart. Old shows (≤ 249) stay as scraped. Safety nets: "Compare with radioštudent", a warning
when the copied HTML is older than the draft, a confirm before replacing an old show.

**2026-10-17 — The SoundCloud and Tags tabs save decisions only; the publish applies them.**
First version applied them to the site's archive immediately. *Why changed:* an archive left
modified on one machine made Sync's `git pull` fail as soon as the automatic GitHub update
committed its own copy. Also keeps the rule simple: nothing reaches the site until you publish.
Sync now merges the two decision files entry by entry instead.

**2026-10-17 — Automatic exact SoundCloud matches are written into `approvals.json` on save.**
*Why:* the candidate list is a local file per machine, so a match living only there would be
dropped again by a publish from the other machine. (The old review page did the same.)
Checked: all 1,562 links already on the site were recorded, so none were at risk.

**2026-10-17 — Re-derive from the radioštudent pages only when an edit is undone, and always
guarded.** *Why:* a bare `scrape-modem.js --reparse` (which the old admin ran on every save)
wiped modem-248/249's tags, 249's episode audio, and shifted heading labels on 195/224/244.
`reparse-guard.js` puts those back; shows built from the draft use their as-built copy.

**2026-10-17 — The website preview server's `/admin` save fixed the same way** (it still
updates the local archive right away, so the preview shows it).

**2026-10-19 — The per-heading editor moved into the show builder ("Edit a show").** Before:
the pencils on show pages, only when the website's local preview server ran (`node
server.js` + logging in at `/admin`). Now: the Edit site tab (the Tags tab renamed) shows a
whole show's headings with their chips, editing the same `segEdits`/`tagEdits`. *Why:*
Matej asked for site editing without running a script. Its chips are computed the way the
site computes them (verified: all 270 records identical to the live site), so what you edit
is what visitors see. Added ⇄ (artist↔label), since a mixed-up artist/label is the common fix.

**2026-10-19 — "Publish site edits": tag and SoundCloud decisions can go live on their own.**
Same rebuild as a show publish, minus the show; the review lists changed shows/headings in
words (a line count said nothing); a local preview of the built site before pushing.
*Why:* decisions otherwise waited up to two weeks for the next show. Refuses while a show
publish is unpushed (one commit per kind of change); refuses the push if edits were saved
after the build. Skips the year-end-list push guard — merges rightly touch lists.

**2026-10-19 — Search text rebuilt after the overrides; empty heading labels cascade.**
*Why:* a track's `searchText` was built before any edit, so a fixed artist wasn't searchable
under the new name, and an undo rebuild (raw page spellings) gave ~140 tracks different
search text than a normal one — noise in every review. Same for a heading edited to "no
label": its tracks kept the old label until a second build. Both checked on the real data:
1 track's search text changes (the fix itself), 0 labels.

**2026-10-22 — The Year-end list tab.** Matej asked for a tool like the show builder for the
yearly list: gather every non-single release from the year's shows, listen as in Arrange,
put in or out, rank with a cut at 50, alphabetical at the end. Built as one tab combining a
Scan-like pool of releases with an Arrange-like ranked list (his "combine download and
arrange into one tab"). *Choices:* singles are gathered but hidden (one button shows them,
in case one is misjudged); releases from earlier years are flagged, not hidden; a link can
add a release that wasn't in a show (3 of 2025's 50); names can be fixed per release for the
list (Bandcamp pages often don't name the label). Saved in one file
(`data/year-end.json`) that Sync carries, newest wins per year — the same rule as the draft.

**2026-10-24 — SoundCloud previews play HLS through hls.js.** SoundCloud's api-v2 no longer
lists a `progressive` (MP3) transcoding for any track checked — only `hls` (aac_160k,
aac_96k; `abr_sq` answers 404) — so `/preview-stream` found nothing and every SoundCloud
single fell back to the widget iframe in Scan (and Year-end). Now `resolveStreamUrl()` falls
back to the unencrypted HLS playlist (`hls: true` in the answer) and `trackPlayerHtml(src,
hls)` / `attachHls()` play it with hls.js 1.5.20 (vendored, Apache-2.0, light build; the
SoundCloud CDN sends CORS `*`). *Why not ffmpeg/a server proxy:* hls.js streams straight
away and seeks; nothing to wait for or clean up. `releaseTrackPlayers()` stops hls.js
loading when a preview closes or the list re-renders.

---

## How it was tested (2026-10-24)

HLS previews, on a throwaway clone with a second show builder on :8190, in Playwright's
Chromium (branded headless Chrome 155 / Edge kept dying after 3–15 s even on a blank page on
the desktop — a local quirk, not the builder):
- A real Scan (22 SoundCloud, 23 Bandcamp): the first 4 SoundCloud singles open as small
  rows (no iframe), play, and seek to the middle and play on from there; no page errors.
- A Bandcamp single still plays through its plain MP3 stream; closing a preview empties it.
- Year-end list (with a copy of `year-end.json`): a SoundCloud set and a Bandcamp release
  both play in the small player.
- The website's player: SoundCloud's widget + Widget API still plays (5 s in after 6 s).

## How it was tested (2026-10-22)

Year-end list, on the real data with a second show builder on :8190 (the data file backed up
before and restored after):
- Gather for 2025 into a test file vs the published "best releases of 2025": 42 of its 49
  releases found (all those played in a 2025 show), none taken for a single.
- Gather for 2026 through the tab's own route (the job queue) with picks saved first: picks
  kept; the same 404 releases as a direct run.
- In headless Chrome: releases listed (singles hidden); a Bandcamp release plays and clicking
  a track jumps to it; a SoundCloud set opens (its tracks looked up) and plays — through
  SoundCloud's widget when there's no plain stream, and goes on to the next track at the end;
  52 in the list → the cut after #50, 2 dimmed below; out; ⤒; drag re-ranks and renumbers;
  Ctrl+Z / Ctrl+Y; a label fix shows and reaches the HTML; a release added from its link
  goes into the list; HTML = the first 50, alphabetical, heading + 50 players; a reload brings
  back the same list.
- Sync's per-year merge (newer copy of each year wins), as a unit check. Not tested: a real
  Sync between the two machines.

## How it was tested (2026-10-19)

In a throwaway clone with a fake GitHub remote (node_modules + scripts/.cache linked in,
`reparse-guard-snapshot.json` backed up and restored), against the real data:
- Chips: `headingsFor()` vs the live site's rendered chips for every show and list (270):
  identical, incl. packed compilations, empty headings, link-filled old headings.
- Through the real UI in Chrome: pick by number / list name / ◀ ▶; ⇄, rename, add, remove,
  track credits, reset of a live edit (→ re-derive path), save; badges.
- Publish site edits end to end: review ("modem-249: heading 10 (artists, labels)", …),
  preview on :8191 showed the edited chips, push → one commit on the fake remote with only
  archive/docs/overrides; the real repo untouched. Second run without an undo; discard
  restores archive + docs and keeps the saved edit.
- Guards: nothing to publish; an unpushed show publish; an unrelated file; a save after the
  build (push refused, nothing reached the remote).
- `apply-overrides.js`: normal rebuild vs undo rebuild → identical archives; old vs new script
  on the committed archive → 1 search text differs.

Not tested: a real push to the live site — the first Publish site edits will be the first.

## How it was tested (2026-10-17)

All in throwaway copies of the repo against the real data, never the real working copy:
- Batch SoundCloud finder before vs after moving its code into a shared module: identical
  output for all 3,101 Bandcamp tracks.
- Arrange: find, "Find links" (adopts links already on record, auto-links exact matches),
  preview, pick, paste, none; picks survive a reload; hidden in Compact view.
- SoundCloud links tab: keyboard picks, search, save.
- Tags tab: merge, edit a release (existing collab lists and title fixes kept), save.
- A test show 250 built from the 249 draft through the real UI: record, 20 tracks indexed,
  cover, `docs/` rebuilt, page rendered in the website preview; refused to replace the old
  scraped 249 without confirmation; survives a later re-derive; never re-scraped.
- Undo path: the un-merged spelling comes back; 248/249 tags and audio and the 195/224/244
  headings unchanged; no year-end list touched (so the push guard stays quiet).
- Two machines with a fake GitHub: decisions on one while the other publishes → Sync merges
  both; Sync explains instead of failing on an unpushed publish; the air date travels.
- Old preview-server `/admin` save: additive and undo.

Not tested: a real publish to the live site — the first one will be show 250.
