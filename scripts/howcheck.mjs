// usage: node howcheck.mjs [port]  — /how behaviour checks: frames, stele hit-testing vs the landscape, reduced motion, WebGL fallback, phone overflow, pixel budget
import { chromium } from '@playwright/test';
const port = process.argv[2] ?? '5173';
const browser = await chromium.connectOverCDP('http://localhost:29229');
const errors = [];
let failed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}: ${label}`); if (!ok) failed++; };
async function open(viewport, url, opts = {}) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: opts.dpr ?? 1, reducedMotion: opts.reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${url} ${String(e)}`));
  page.on('console', m => { if (m.type() === 'error' && !(opts.noGL && /WebGL context/.test(m.text()))) errors.push(`${url} ${m.text()}`); });
  if (opts.noGL) await page.addInitScript(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : g.call(this, t, ...a); }; });
  await page.goto(`http://localhost:${port}${url}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  return { context, page, data: () => page.evaluate(() => ({ ...document.body.dataset })) };
}
const desktop = { width: 1440, height: 900 }, phone = { width: 390, height: 844 };

// frames: labels select the carousel position, ascend is the end state, unknown names fall back to the loop
for (const [frame, idx] of [['the loop', 0], ['observe', 1], ['evaluate', 2], ['refine', 3], ['ascend', 4], ['nope', 0]]) {
  const { context, page } = await open(desktop, `/how?frame=${encodeURIComponent(frame)}`);
  await page.waitForTimeout(1500);
  const current = await page.locator('#carousel [aria-current="true"]').evaluate(el => ({ index: Number(el.dataset.index), text: el.textContent.trim() })).catch(() => ({ index: -1, text: '' }));
  const d = await page.evaluate(() => ({ ...document.body.dataset }));
  check(current.index === idx && d.end === (idx === 4 ? 'on' : 'off') && d.renderer === 'ready' && ['full', 'mid', 'lite'].includes(d.tier), `frame=${frame} → carousel at ${idx} (${current.text}), renderer ready, tier ${d.tier}`);
  await context.close();
}

// hit-testing: a tap on the stele opens it, a tap on the landscape beside it does not, Escape closes
{
  const { context, page, data } = await open(desktop, '/how?frame=evaluate');
  await page.waitForTimeout(4000);
  await page.mouse.click(1300, 520); await page.waitForTimeout(400);
  check((await data()).open !== 'on', 'tap on the landscape beside the stele does not open the stone');
  await page.mouse.click(720, 400); await page.waitForTimeout(600);
  check((await data()).open === 'on', 'tap on the stele opens it');
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  check((await data()).open === 'off', 'Escape closes it');
  const canvasPx = await page.locator('canvas#scene').evaluate(c => c.width * c.height);
  check(canvasPx <= 2_400_000, `canvas ${canvasPx} px within the 2.4 MP budget`);
  await context.close();
}
// hidpi: the canvas still fits the tier budget at devicePixelRatio 2
{
  const { context, page, data } = await open(desktop, '/how', { dpr: 2 });
  await page.waitForTimeout(1500);
  const [w, h] = await page.locator('canvas#scene').evaluate(c => [c.width, c.height]);
  const budget = { full: 2_400_000, mid: 1_800_000, lite: 1_200_000 }[(await data()).tier];
  check(w * h <= budget + 1, `dpr 2: canvas ${w}x${h} within the ${(await data()).tier} budget`);
  await context.close();
}
// reduced motion
{
  const { context, page, data } = await open(desktop, '/how?frame=refine', { reduced: true });
  await page.waitForTimeout(2000);
  check((await data()).renderer === 'ready', 'reduced motion: page renders and is ready');
  await context.close();
}
// WebGL fallback
{
  const { context, page, data } = await open(desktop, '/how', { noGL: true });
  const fallbackShown = await page.locator('#fallback').isVisible();
  check((await data()).renderer === 'fallback' && fallbackShown, 'WebGL unavailable: fallback copy shown');
  await context.close();
}
// phone layout
{
  const { context, page, data } = await open(phone, '/how?frame=ascend');
  await page.waitForTimeout(1500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  check(overflow <= 0, `390px layout without horizontal overflow (${overflow})`);
  check((await data()).end === 'on', 'phone: ascend frame reached');
  await context.close();
}
const real = errors.filter(e => !/favicon/.test(e));
check(real.length === 0, `zero console/page errors${real.length ? ': ' + real.join(' | ') : ''}`);
await browser.close();
process.exit(failed ? 1 : 0);
