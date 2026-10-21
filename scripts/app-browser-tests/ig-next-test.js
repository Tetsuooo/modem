// Reproduce "next doesn't always auto-play in Instagram's in-app browser".
// Headless Chromium with Android WebView's media rule (--autoplay-policy=user-gesture-required),
// a phone viewport + Instagram-on-Android user agent (so the site switches to its app-browser
// mode). Every HTMLMediaElement.play() in every frame (incl. SoundCloud's widget) is logged with
// a per-element id and whether the browser allowed it.
// usage: node ig-next-test.js [baseUrl] [nexts]
const { chromium } = require('E:/ART/websites/driftweb/node_modules/playwright');
const BASE = process.argv[2] || 'https://modemodemodem.xyz';
const NEXTS = Number(process.argv[3] || 10);
const MODE = process.argv[4] || 'instagram'; // 'instagram' (Android WebView rule) or 'chrome' (normal phone browser)
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.6723.58 Mobile Safari/537.36 Instagram 353.0.0.0.0 Android';

const HOOK = () => {
  if (window.__playHook) return; window.__playHook = true;
  const ids = new WeakMap(); let n = 0;
  const idOf = (m) => { if (!ids.has(m)) ids.set(m, ++n); return ids.get(m); };
  const where = location.hostname;
  const orig = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const id = idOf(this);
    const src = (this.currentSrc || this.src || '').replace(/\?.*/, '').slice(0, 70);
    let p;
    try { p = orig.apply(this, arguments); } catch (e) { console.log(`[media ${where}] el#${id} play() threw ${e.name}`); throw e; }
    if (p && p.then) p.then(() => console.log(`[media ${where}] el#${id} play() OK  ${src}`),
                            (e) => console.log(`[media ${where}] el#${id} play() BLOCKED ${e.name}  ${src}`));
    return p;
  };
};

(async () => {
  const browser = await chromium.launch({ headless: true, args: [MODE === 'instagram' ? '--autoplay-policy=user-gesture-required' : '--autoplay-policy=document-user-activation-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: MODE === 'instagram' ? UA : UA.replace('; wv)', ')').replace(/ Instagram.*/, '') });
  await ctx.addInitScript(HOOK);
  const page = await ctx.newPage();
  const t0 = Date.now(); const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
  page.on('console', (m) => { const t = m.text(); if (t.startsWith('[media')) console.log(ts(), '   ', t); });

  const state = async (label) => {
    const s = await page.evaluate(() => {
      const el = document.getElementById('modem-player');
      return { playing: !!el && el.classList.contains('mp-playing'), title: (el && el.querySelector('.mp-title') || {}).textContent || '',
               appBrowser: document.documentElement.classList.contains('app-browser'), frames: document.querySelectorAll('iframe.mp-hidden').length, ready: !!el && el.classList.contains('mp-next-ready') };
    });
    console.log(ts(), `${label.padEnd(14)} ${s.playing ? 'PLAYING ' : 'not playing'}  "${s.title}"  [${s.appBrowser ? 'app-browser' : 'normal'} mode, ${s.frames} SC frame(s)${s.ready ? ', next ready' : ''}]`);
    return s;
  };


  const debug = async () => {
    const d = await page.evaluate(() => {
      const el = document.getElementById('modem-player');
      const nb = el.querySelector('.mp-next').getBoundingClientRect();
      const at = document.elementFromPoint(nb.left + nb.width / 2, nb.top + nb.height / 2);
      const tw = [...document.querySelectorAll('.mp-tapwin')].map((t) => { const r = t.getBoundingClientRect(); return t.className.replace('mp-tapwin ', '') + '@' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' pe=' + getComputedStyle(t).pointerEvents + ' title=' + t.querySelector('iframe').title.replace('modem player', 'mp'); });
      return 'next btn @' + Math.round(nb.left) + ',' + Math.round(nb.top) + ' | top element there: ' + (at ? (at.tagName + '.' + (at.className || '') + (at.closest('.mp-tapwin') ? ' in ' + at.closest('.mp-tapwin').className : '')) : 'none') + ' | ' + tw.join(' ; ');
    });
    console.log('       debug:', d);
    const out = [];
    for (const f of page.frames().filter((f) => f.url().includes('w.soundcloud.com/player'))) {
      const st = await f.evaluate(() => { const b = document.querySelector('.playButton'); window.__real = { playing: !!(b && b.classList.contains('playing')), text: document.body.innerText }; const t = document.querySelector('.soundTitle__title, .soundTitle__titleContainer, .title, h1, .sc-truncate'); return (b ? b.className.replace(/s+/g, ' ') : 'no .playButton') + ' | ' + (t ? t.textContent.trim().slice(0, 40) : '?'); }).catch((e) => 'eval failed: ' + e.message);
      console.log('       frame:', st.replace(/s+/g, ' '));
      out.push(await f.evaluate(() => window.__real).catch(() => null));
    }
    return out.filter(Boolean);
  };
  await page.goto(BASE + '/radio-show', { waitUntil: 'networkidle' });
  { const b = await page.locator('.modem-action[data-act="tracks"]').boundingBox(); await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2); }
  await page.waitForTimeout(6000);
  await state('random track');
  // tap the play button where the SoundCloud tap window sits (app-browser mode)
  const box = await page.locator('#modem-player .mp-toggle').boundingBox();
  if (!(await page.evaluate(() => document.getElementById('modem-player').classList.contains('mp-playing')))) await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(5000);
  await state('tap play');
  await debug();
  let ok = 0;
  for (let i = 1; i <= NEXTS; i++) {
    const nb = await page.locator('#modem-player .mp-next').boundingBox();
    await page.touchscreen.tap(nb.x + nb.width / 2, nb.y + nb.height / 2); // like a finger: lands on whatever is on top
    await page.waitForTimeout(7000);
    const s = await state(`next #${i}`);
    const fr = await debug();
    const real = s.playing && fr.filter((x) => x.playing).length === 1 && fr.some((x) => x.playing && x.text.includes(s.title.slice(0, 12)));
    console.log('       => ' + (real ? 'OK: the frame actually playing has this track' : 'NOT OK'));
    if (real) ok++;
  }
  console.log(`\nauto-played after next: ${ok} of ${NEXTS}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
