// "play random track" then ▶ in Instagram's browser, with realistic timing (tap before the page has
// finished loading) and several phone sizes. Logs where the tap window over ▶ sits vs the button,
// its pointer-events, the player's playing state, and what SoundCloud says.
// usage: node ig-first-play.js [baseUrl] [waitBeforeTapMs]
const { chromium } = require('E:/ART/websites/driftweb/node_modules/playwright');
const BASE = process.argv[2] || 'https://modemodemodem.xyz';
const WAIT = Number(process.argv[3] || 0);
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 Instagram 353.0.0.0.0 Android';
const SIZES = process.env.SLOW ? [[412, 915, 2.625]] : [[412, 915, 2.625], [393, 852, 2.75], [360, 780, 3]];
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=user-gesture-required'] });
  for (const [w, h, dpr] of SIZES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, userAgent: UA });
    await ctx.addInitScript(() => { const o = HTMLMediaElement.prototype.play; HTMLMediaElement.prototype.play = function () { const p = o.apply(this, arguments); if (p && p.then) p.then(() => console.log('[audio] play OK'), (e) => console.log('[audio] play ' + e.name)); return p; }; });
    const page = await ctx.newPage();
    if (process.env.SLOW) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 }); await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 }); }
    const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
    page.on('console', (m) => { if (m.text().startsWith('[audio]')) console.log(ts(), '     ', m.text()); });
    const snap = async (label) => {
      const s = await page.evaluate(() => {
        const el = document.getElementById('modem-player'); if (!el || el.hidden) return 'player hidden';
        const r = (x) => { if (!x) return 'none'; const b = x.getBoundingClientRect(); return Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height); };
        const tb = el.querySelector('.mp-toggle'), tw = document.querySelector('.mp-tapwin.tw-play');
        const c = tb.getBoundingClientRect(); const at = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
        return `${el.classList.contains('mp-playing') ? 'UI PLAYING' : 'UI paused'} | toggle ${r(tb)} | tw-play ${r(tw)} pe=${tw ? getComputedStyle(tw).pointerEvents : '-'} | on top at ▶: ${at ? at.tagName + (at.closest('.mp-tapwin') ? '(tapwin ' + at.closest('.mp-tapwin').className.replace('mp-tapwin ', '') + ')' : '') : 'nothing'} | iframe src ${tw && tw.querySelector('iframe').getAttribute('src') ? 'set' : 'EMPTY'}`;
      });
      const sc = await page.evaluate(() => new Promise((res) => { const f = document.querySelector('#modem-player .tw-play iframe'); if (!f || !f.getAttribute('src') || !window.SC) return res('-'); const w = SC.Widget(f); let d = false; setTimeout(() => { if (!d) { d = true; res('no answer'); } }, 2000); w.isPaused((p) => { if (!d) { d = true; res(p ? 'SC paused' : 'SC PLAYING'); } }); }));
      console.log(ts(), label.padEnd(18), s, '|', sc);
    };
    console.log(`\n=== ${w}x${h} @${dpr}, tap ${WAIT} ms after the page starts loading`);
    await page.goto(BASE + '/radio-show', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.modem-action[data-act="tracks"]');
    await page.waitForTimeout(WAIT);
    { const b = await page.locator('.modem-action[data-act="tracks"]').boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); }
    for (let i = 0; i < (process.env.SLOW ? 6 : 3); i++) { await page.waitForTimeout(process.env.SLOW ? 3000 : 1500); await snap('after random ' + (i + 1)); }
    const b = await page.locator('#modem-player .mp-toggle').boundingBox();
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(3000); await snap('after tap ▶');
    await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(3000); await snap('after 2nd tap ▶');
    await ctx.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
