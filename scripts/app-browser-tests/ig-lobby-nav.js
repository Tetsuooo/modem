// The lobby windows must step off "play random show / track" when something covers them (search)
// or the page changes, and come back on the radio-show page. Instagram emulation as in ig-lobby-test.
const { chromium } = require('E:/ART/websites/driftweb/node_modules/playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:8087';
const IG_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 Instagram 353.0.0.0.0 Android';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: IG_UA });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const tapAt = async (sel) => { const b = await page.locator(sel).first().boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); };
  const report = async (label) => {
    const r = await page.evaluate(() => {
      const ws = [...document.querySelectorAll('.mp-tapwin')].map((w) => { const b = w.getBoundingClientRect(); return `${w.className.replace('mp-tapwin ', '')}@${Math.round(b.left)},${Math.round(b.top)}`; });
      const btn = document.querySelector('.modem-action[data-act="tracks"]');
      let atBtn = 'no button on this page';
      if (btn) { const b = btn.getBoundingClientRect(); const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); atBtn = top ? (top.closest('.mp-tapwin') ? 'SoundCloud window' : top.tagName + '.' + String(top.className).slice(0, 30)) : 'nothing'; }
      return `${location.pathname} | windows ${ws.join(' ')} | on top at "play random track": ${atBtn}`;
    });
    console.log(label.padEnd(30), r);
  };
  const lobbyReady = async () => { for (let i = 0; i < 120; i++) { if (await page.evaluate(() => document.querySelectorAll('.mp-tapwin.live').length === 2)) return true; await page.waitForTimeout(250); } return false; };
  await page.goto(BASE + '/radio-show', { waitUntil: 'domcontentloaded' });
  console.log('lobby ready:', await lobbyReady());
  await report('radio-show, lobby ready');
  await tapAt('.modem-action[data-act="search"]'); await page.waitForTimeout(400);
  await report('search open');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  if (await page.evaluate(() => !document.getElementById('modem-search').hidden)) { await tapAt('#modem-search .ms-close'); await page.waitForTimeout(400); }
  await report('search closed');
  // another page through the site's own navigation
  const href = await page.evaluate(() => { const a = [...document.querySelectorAll('a[href^="/"]')].find((x) => x.offsetParent && !/radio-show/.test(x.getAttribute('href'))); return a ? a.getAttribute('href') : null; });
  console.log('navigating to', href);
  await page.evaluate((h) => { const a = [...document.querySelectorAll('a[href^="/"]')].find((x) => x.getAttribute('href') === h); a.click(); }, href);
  await page.waitForTimeout(1500);
  await report('other page');
  await page.goBack(); await page.waitForTimeout(500);
  console.log('lobby ready again:', await lobbyReady());
  await report('back on radio-show');
  await tapAt('.modem-action[data-act="tracks"]'); await page.waitForTimeout(5000);
  const st = await page.evaluate(() => { const el = document.getElementById('modem-player'); return (el.hidden ? 'closed' : el.classList.contains('mp-playing') ? 'PLAYING' : 'open, paused') + ' "' + el.querySelector('.mp-title').textContent + '"'; });
  console.log('tap "play random track"'.padEnd(30), st);
  console.log(errors.length ? 'PAGE ERRORS:\n  ' + errors.join('\n  ') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
