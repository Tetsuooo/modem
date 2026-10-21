// "play random track / show" should start playing with ONE tap in Instagram's browser (the lobby:
// SoundCloud players wait, loaded and paused, under those buttons while the player is closed).
// usage: node ig-lobby-test.js [baseUrl] [instagram|chrome] [width]x[height]
const { chromium } = require('E:/ART/websites/driftweb/node_modules/playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:8087';
const MODE = process.argv[3] || 'instagram';
const [VW, VH] = (process.argv[4] || '390x844').split('x').map(Number);
const IG_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 Instagram 353.0.0.0.0 Android';
const CHROME_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36';

(async () => {
  const browser = await chromium.launch({ headless: true, args: [MODE === 'instagram' ? '--autoplay-policy=user-gesture-required' : '--autoplay-policy=document-user-activation-required'] });
  const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2, isMobile: VW < 800, hasTouch: true, userAgent: MODE === 'instagram' ? IG_UA : CHROME_UA });
  await ctx.addInitScript(() => { if (window.__mh) return; window.__mh = true; window.__media = []; const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { if (!window.__media.includes(this)) window.__media.push(this); return o.apply(this, arguments); }; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  // a finger: lands on whatever is on top at that point (fx, fy = where in the button, 0..1)
  const tapAt = async (sel, fx = 0.5, fy = 0.5) => { const b = await page.locator(sel).boundingBox(); await page.touchscreen.tap(b.x + b.width * fx, b.y + b.height * fy); };
  const SHOWS = '.modem-action[data-act="shows"]', TRACKS = '.modem-action[data-act="tracks"]';
  let fails = 0;
  const look = async (label, expect) => {
    const ui = await page.evaluate(() => {
      const el = document.getElementById('modem-player');
      return { open: !el.hidden, playing: el.classList.contains('mp-playing'), title: el.querySelector('.mp-title').textContent };
    });
    const real = [];
    for (const f of page.frames().filter((f) => f.url().includes('w.soundcloud.com/player'))) {
      const t1 = await f.evaluate(() => (window.__media || []).map((m) => m.currentTime)).catch(() => []);
      await page.waitForTimeout(700);
      const r = await f.evaluate((t1) => { const ms = window.__media || []; const live = ms.some((m, i) => !m.paused && m.currentTime > (t1[i] || 0) + 0.2); return { playing: live, text: document.body.innerText, title: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 45) }; }, t1).catch(() => null);
      if (r) real.push(r);
    }
    const playingFrames = real.filter((r) => r.playing);
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const match = playingFrames.length === 1 && norm(playingFrames[0].text).includes(norm(ui.title).slice(0, 10));
    const state = !ui.open ? (playingFrames.length ? 'CLOSED but something plays!' : 'closed, silent')
      : ui.playing ? (match ? 'PLAYING (verified)' : `UI says playing but ${playingFrames.length} frame(s) play` + (playingFrames.length ? ' something else' : ''))
      : (playingFrames.length ? `NOT playing in UI but ${playingFrames.length} frame(s) play!` : 'waiting (paused)');
    const ok = !expect || state.startsWith(expect);
    if (!ok) fails++;
    console.log(ts(), (ok ? '  ' : '✗ ') + label.padEnd(36), state.padEnd(34), `"${ui.title.slice(0, 40)}"  audible: ${playingFrames.map((r) => r.title.slice(0, 30)).join(' + ') || '-'}`);
  };
  const lobbyReady = async (max = 30000) => {
    const t = Date.now();
    while (Date.now() - t < max) {
      const n = await page.evaluate(() => (document.getElementById('modem-player').hidden ? document.querySelectorAll('.mp-tapwin.live').length : -1));
      if (n === 2) return (Date.now() - t) / 1000;
      await page.waitForTimeout(250);
    }
    return null;
  };
  const geometry = () => page.evaluate(() => {
    const r = (x) => { const b = x.getBoundingClientRect(); return `${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`; };
    const s = document.querySelector('.modem-action[data-act="shows"]'), t = document.querySelector('.modem-action[data-act="tracks"]');
    const w = [...document.querySelectorAll('.mp-tapwin')];
    return `show btn ${r(s)} / win ${r(w[0])} ${w[0].style.transform || ''} | track btn ${r(t)} / win ${r(w[1] || w[0])} ${(w[1] || w[0]).style.transform || ''}`;
  });

  console.log(`mode: ${MODE}, ${VW}x${VH}`);
  await page.goto(BASE + '/radio-show', { waitUntil: 'domcontentloaded' });
  t0 = Date.now();
  if (MODE === 'instagram') {
    const r = await lobbyReady();
    console.log(ts(), r == null ? '✗ lobby never got ready' : `  lobby ready after ${r}s`); if (r == null) fails++;
    console.log('       ' + await geometry());
    // 1. one tap on "play random track"
    await tapAt(TRACKS); await page.waitForTimeout(5000); await look('1 tap "play random track"', 'PLAYING');
    // 2. next still works after a lobby start (the spare took over the other frame)
    await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next', 'PLAYING');
    // 3. close (silence), then one tap on "play random show", near its left end
    await tapAt('#modem-player .mp-close'); await page.waitForTimeout(1500); await look('close', 'closed, silent');
    const r2 = await lobbyReady();
    console.log(ts(), r2 == null ? '✗ lobby not ready again' : `  lobby ready again after ${r2}s`); if (r2 == null) fails++;
    await tapAt(SHOWS, 0.1, 0.3); await page.waitForTimeout(5000); await look('1 tap "play random show" (near end)', 'PLAYING');
    // 4. our pause / play
    await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(2500); await look('pause', 'waiting');
    await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(3500); await look('play again', 'PLAYING');
    await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next', 'PLAYING');
    // 5. close and straight back to a random track
    await tapAt('#modem-player .mp-close'); await page.waitForTimeout(500);
    const r3 = await lobbyReady();
    console.log(ts(), r3 == null ? '✗ lobby not ready again' : `  lobby ready again after ${r3}s`); if (r3 == null) fails++;
    await tapAt(TRACKS); await page.waitForTimeout(5000); await look('1 tap "play random track" again', 'PLAYING');
    await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next', 'PLAYING');
    // 6. a tap before anything is ready: the player opens waiting; a tap on play starts it
    await page.goto(BASE + '/radio-show', { waitUntil: 'domcontentloaded' });
    t0 = Date.now();
    await page.waitForSelector(TRACKS); await page.waitForTimeout(300);
    await tapAt(TRACKS); await page.waitForTimeout(7000); await look('early tap "play random track"', 'waiting');
    await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(5000); await look('tap play', 'PLAYING');
    await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next', 'PLAYING');
  } else {
    await page.waitForLoadState('networkidle');
    console.log('       windows: ' + await page.evaluate(() => [...document.querySelectorAll('.mp-tapwin')].map((w) => w.getBoundingClientRect().left).join(', ')));
    await tapAt(TRACKS); await page.waitForTimeout(6000); await look('tap "play random track"', 'PLAYING');
    await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next', 'PLAYING');
    await tapAt('#modem-player .mp-close'); await page.waitForTimeout(1500); await look('close', 'closed, silent');
    await tapAt(SHOWS); await page.waitForTimeout(6000); await look('tap "play random show"', 'PLAYING');
  }
  console.log(errors.length ? 'PAGE ERRORS:\n  ' + errors.join('\n  ') : 'no page errors');
  console.log(fails ? `${fails} FAILED` : 'all as expected');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
