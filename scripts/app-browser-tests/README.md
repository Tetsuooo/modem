# App-browser tests (Instagram / Facebook in-app browser)

The floating player (src/index.html) works differently inside app browsers: on Android they are a
WebView, which only starts audio from a tap **inside the frame that plays it**, which here is
SoundCloud's cross-origin widget. A tap on our own button can load a track but never start it. So,
in app browsers only (`html.app-browser`, set in index.html's `<head>` from the user agent),
invisible SoundCloud players sit under our buttons, and the tap lands in SoundCloud's play button:

- **Play:** the current player sits under ▶ while a track is loaded and paused (f459c7e).
- **Next:** a second "spare" player, loaded with the next track and paused, sits under ⏭. On its PLAY
  the two swap roles (2e181f4).
- **Phantom PLAYs:** SoundCloud sometimes reports PLAY without playing, so PLAY is checked with
  isPaused (903f9d7).
- **The lobby:** while the player is closed on /radio-show, a random show and a random track wait
  under "play random show / track", so one tap opens the player already playing (19bd444). The
  windows copy each button's size and tilt; the frame is stretched so SoundCloud's 43×43 play
  button fills the window. They step aside when the search or another page covers the buttons.
- **Still one tap on ▶ in app browsers:** previous, the automatic next at a track's end, and the
  track ▶ buttons on show pages / in the search.
- **Debugging on a real phone:** add `#mpdebug` to the address. A panel shows the windows against
  the buttons, each SoundCloud player's state and the last events.

## Running the tests

The tests use Playwright from `E:/ART/websites/driftweb/node_modules/playwright` and run headless,
so no windows appear. They emulate the WebView rule with `--autoplay-policy=user-gesture-required`
plus an Instagram-on-Android user agent, tap like a finger (`page.touchscreen.tap`), and check for
**real** audio (the media element's currentTime moving inside SoundCloud's frames).

```
node scripts/app-browser-tests/gz-preview.js              # local preview, gzip like GitHub Pages
node scripts/app-browser-tests/ig-lobby-test.js http://127.0.0.1:8087 instagram          # one-tap random buttons
node scripts/app-browser-tests/ig-lobby-test.js http://127.0.0.1:8087 instagram 1024x768 # tablet (tilted buttons)
node scripts/app-browser-tests/ig-lobby-test.js http://127.0.0.1:8087 chrome             # normal phone browser
node scripts/app-browser-tests/ig-lobby-nav.js  http://127.0.0.1:8087    # windows vs search / page change
node scripts/app-browser-tests/ig-next-test.js  http://127.0.0.1:8087 10 # 10 × next
node scripts/app-browser-tests/ig-edge-test.js  http://127.0.0.1:8087 instagram  # quick taps, previous, pause, mini bar, track end
SLOW=1 node scripts/app-browser-tests/ig-first-play.js http://127.0.0.1:8087     # throttled phone, tap while loading
node scripts/app-browser-tests/ig-dead-test.js  http://127.0.0.1:8087    # a removed SoundCloud track in the queue
```

Use `https://modemodemodem.xyz` as the address to test the live site.

Gotchas:

- **Title mismatches:** "UI says playing but … something else" is often only a naming difference. The
  archive's title differs from SoundCloud's (renamed tracks, styled Unicode, "untitled"). Look at
  what's audible before calling it a bug.
- **Slow-phone test needs gzip:** a plain static server sends the archive uncompressed (12.9 MB), so
  `SLOW=1` runs look broken when they aren't. Use gz-preview.js.
- **SoundCloud's `load()` replaces the frame's address:** a second load before the first is in drops
  the first one's callback. Anything waiting on a load needs a time limit (loadPaused has one).
- **Moving a frame reloads it:** the windows are positioned by script and never moved in the page.
