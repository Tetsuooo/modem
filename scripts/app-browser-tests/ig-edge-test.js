// Edge cases for the app-browser "spare player under next" change (see ig-next-test.js).
// usage: node ig-edge-test.js [baseUrl] [instagram|chrome]
const { chromium } = require('E:/ART/websites/driftweb/node_modules/playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:8087';
const MODE = process.argv[3] || 'instagram';
const IG_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 Instagram 353.0.0.0.0 Android';
const CHROME_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36';

(async () => {
  const browser = await chromium.launch({ headless: true, args: [MODE === 'instagram' ? '--autoplay-policy=user-gesture-required' : '--autoplay-policy=document-user-activation-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: MODE === 'instagram' ? IG_UA : CHROME_UA });
  await ctx.addInitScript(() => { if (window.__mh) return; window.__mh = true; window.__media = []; const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { if (!window.__media.includes(this)) window.__media.push(this); return o.apply(this, arguments); }; });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  const tapAt = async (sel) => { const b = await page.locator(sel).boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
  // what the player shows + which SoundCloud frames really play (and what)
  const look = async (label) => {
    const ui = await page.evaluate(() => {
      const el = document.getElementById('modem-player');
      return { playing: el.classList.contains('mp-playing'), title: el.querySelector('.mp-title').textContent, ready: el.classList.contains('mp-next-ready'),
               mini: el.classList.contains('mp-mini'), frames: document.querySelectorAll('iframe.mp-hidden').length };
    });
    const real = [];
    for (const f of page.frames().filter((f) => f.url().includes('w.soundcloud.com/player'))) {
      const t1 = await f.evaluate(() => (window.__media || []).map((m) => m.currentTime)).catch(() => []);
      await page.waitForTimeout(700);
      const r = await f.evaluate((t1) => { const ms = window.__media || []; const live = ms.some((m, i) => !m.paused && m.currentTime > (t1[i] || 0) + 0.2); return { playing: live, text: document.body.innerText, title: document.body.innerText.replace(/s+/g, ' ').trim().slice(0, 45) }; }, t1).catch(() => null);
      if (r) real.push(r);
    }
    const playingFrames = real.filter((r) => r.playing);
    const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, '');
    const match = playingFrames.length === 1 && norm(playingFrames[0].text).includes(norm(ui.title).slice(0, 10));
    const audible = playingFrames.map((r) => r.title.slice(0, 30)).join(' + ') || '-';
    const verdict = ui.playing ? (match ? 'PLAYING (verified)' : `UI says playing but ${playingFrames.length} frame(s) play` + (playingFrames.length ? ' something else' : '')) : (playingFrames.length ? `NOT playing in UI but ${playingFrames.length} frame(s) play!` : 'waiting (paused)');
    console.log(ts(), label.padEnd(30), verdict.padEnd(40), `"${ui.title.slice(0, 40)}"  frames=${ui.frames}${ui.ready ? ' next-ready' : ''}${ui.mini ? ' MINI' : ''}  audible: ${audible}`);
    return { ui, match };
  };

  console.log(`mode: ${MODE}`);
  await page.goto(BASE + '/radio-show', { waitUntil: 'networkidle' });
  { const b = await page.locator('.modem-action[data-act="tracks"]').boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); }
  await page.waitForTimeout(6000);
  await look('random track');
  if (MODE === 'instagram' && !(await page.evaluate(() => document.getElementById('modem-player').classList.contains('mp-playing')))) { await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(5000); await look('tap play'); }

  // 1. plain next
  await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next');
  // 2. two quick taps on next (the 2nd before the spare is ready again)
  await tapAt('#modem-player .mp-next'); await page.waitForTimeout(400); await tapAt('#modem-player .mp-next');
  await page.waitForTimeout(6000); await look('next, next (quick)');
  if (MODE === 'instagram' && !(await page.evaluate(() => document.getElementById('modem-player').classList.contains('mp-playing')))) { await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(5000); await look('  tap play (if it waited)'); }
  await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next after that');
  // 3. previous, then next
  await tapAt('#modem-player .mp-prev'); await page.waitForTimeout(6000); await look('previous');
  if (MODE === 'instagram' && !(await page.evaluate(() => document.getElementById('modem-player').classList.contains('mp-playing')))) { await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(5000); await look('  tap play'); }
  await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next after previous');
  // 4. pause / resume with our button
  await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(2500); await look('pause');
  await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(3500); await look('resume');
  // 5. minimised bar (phones): the windows must follow the smaller buttons
  await page.locator('#modem-player .mp-min').tap(); await page.waitForTimeout(1500);
  await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next in the mini bar');
  const tw = await page.evaluate(() => {
    const el = document.getElementById('modem-player');
    const r = (q) => { const x = el.querySelector(q); if (!x) return null; const b = x.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2), Math.round(b.width)]; };
    return { play: r('.mp-toggle'), next: r('.mp-next'), twPlay: (() => { const b = document.querySelector('.mp-tapwin.tw-play').getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2), Math.round(b.width)]; })(), twNext: (() => { const x = document.querySelector('.mp-tapwin.tw-next'); if (!x) return null; const b = x.getBoundingClientRect(); return [Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2), Math.round(b.width)]; })() };
  });
  console.log('       mini bar centres [x,y,width]: play', tw.play, 'tw-play', tw.twPlay, '| next', tw.next, 'tw-next', tw.twNext);
  // 6. the track ends by itself: scrub to the very end
  const bar = await page.locator('#modem-player .mp-bar').boundingBox();
  await page.touchscreen.tap(bar.x + bar.width * 0.995, bar.y + bar.height / 2);
  await page.waitForTimeout(9000); await look('track ended by itself');
  if (MODE === 'instagram' && !(await page.evaluate(() => document.getElementById('modem-player').classList.contains('mp-playing')))) { await tapAt('#modem-player .mp-toggle'); await page.waitForTimeout(5000); await look('  tap play'); }
  await tapAt('#modem-player .mp-next'); await page.waitForTimeout(6000); await look('next after that');
  console.log(errors.length ? 'PAGE ERRORS:\n  ' + errors.join('\n  ') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
