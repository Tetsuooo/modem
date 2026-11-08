# Notes for Claude

This repo is the modemodemodem.xyz website (`src/`, built into `docs/`, which GitHub Pages
serves) and the show builder (`show-builder/`), which Matej runs on two computers (a desktop
PC and a Surface) kept in step through GitHub.

- **Commit builder code changes on `main` as soon as they work** (`show-builder/`,
  `scripts/`). The builder's publish won't start on top of uncommitted files it didn't make,
  and the other computer only gets what's committed (2026-11-07: three uncommitted files
  stopped show 251's publish). Don't push unless asked: the builder's Confirm & push and its
  Sync push local commits.
- **Don't edit while a publish is waiting to be pushed.** Confirm & push commits every
  changed file (`git add -A`), so an edit lands in the show's commit. Run `git status`
  first: a changed `src/assets/modem-archive.json`, `docs/` or a new cover means a publish is
  in progress.
- PowerShell 5.1 mangles quotes in `git commit -m "…"`: write the message to a file and use
  `git commit -F <file>`.
- `show-builder/README.md` is the running log ("Where we left off (date)"). Add an entry for
  each change, in plain words, for Matej.
- After changing server code, the running builder needs a restart (the page shows a banner).
