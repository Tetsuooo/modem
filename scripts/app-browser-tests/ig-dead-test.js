// Dead track next in line (modem 242: "The drug-resistant sickness unto death" -> "carpundia",
// which SoundCloud no longer plays). Shuffle off, start on the track before it, tap play, then:
// the spare must skip carpundia, and a tap on next must start the track after it.
const { chromium } = require('E:/ART/websites/driftweb/node_modules/playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:8087';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 Instagram 353.0.0.0.0 Android';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const tapAt = async (sel) => { const b = await page.locator(sel).boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
  const sounds = () => page.evaluate(() => Promise.all([...document.querySelectorAll('.mp-tapwin')].map((tw) => new Promise((res) => {
    const w = SC.Widget(tw.querySelector('iframe')); let done = false; const fin = (v) => { if (!done) { done = true; res(v); } };
    setTimeout(() => fin(tw.className + ': (no answer)'), 3000);
    w.getCurrentSound((s) => w.isPaused((p) => fin(tw.className.replace('mp-tapwin ', '') + ': ' + (s && s.title ? `"${s.title.slice(0, 45)}"` : 'DEAD/EMPTY') + (p ? ' paused' : ' PLAYING'))));
  }))));
  const ui = () => page.evaluate(() => { const el = document.getElementById('modem-player'); return `player shows "${el.querySelector('.mp-title').textContent}" ${el.classList.contains('mp-playing') ? 'PLAYING' : 'paused'}${el.classList.contains('mp-next-ready') ? ', next ready' : ''}`; });

  await page.goto(BASE + '/radio-show', { waitUntil: 'networkidle' });
  { const b = await page.locator('.modem-action[data-act="tracks"]').boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); }          // shows the player
  await page.waitForTimeout(5000);
  await page.locator('#mp-shuffle').tap();                       // shuffle off: show order
  await page.waitForTimeout(500);
  await page.evaluate(() => { const tk = window.__modemData.tracks.find((t) => t.key === 'sc:2342810507'); window.modemPlayer.playTrack(tk); });
  await page.waitForTimeout(8000);
  console.log('started on the track before carpundia:', await ui());
  await tapAt('#modem-player .mp-toggle');
  await page.waitForTimeout(5000);
  console.log('after tap play:', await ui());
  (await sounds()).forEach((x) => console.log('   ', x));
  await tapAt('#modem-player .mp-next');
  await page.waitForTimeout(7000);
  console.log('after tap next:', await ui());
  (await sounds()).forEach((x) => console.log('   ', x));
  console.log(errors.length ? 'PAGE ERRORS: ' + errors.join(' | ') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
