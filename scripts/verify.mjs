import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://localhost:29229');
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
async function ready(target, frame = '') {
  await target.bringToFront();
  await target.goto(`http://localhost:5173/${frame ? `?frame=${frame}` : ''}`);
  await target.waitForFunction(() => document.body.dataset.ready === 'true');
  await target.waitForTimeout(250);
}
const counter = () => page.locator('#counter').textContent();
const visiblePanels = () => page.locator('.panel:visible').count();
try {
  for (const [frame, expected, open] of [['rest', 'iter 000', 0], ['mid', 'iter 003', 4], ['beauty', 'iter 004 · beauty', 0]]) {
    await ready(page, frame);
    assert.equal(await page.locator('body').getAttribute('data-renderer'), 'ready');
    assert.equal(await page.locator('body').getAttribute('data-intro'), 'done');
    assert.equal(await counter(), expected);
    assert.equal(await visiblePanels(), open);
    assert.equal(await page.locator('canvas').count(), 1);
    const size = await page.locator('canvas').evaluate(c => [c.width, c.height]);
    assert(size[0] * size[1] <= 2_400_000);
  }
  console.log('PASS: rest/mid/beauty frames, panel counts, one canvas within the pixel budget');
  for (const frame of ['unknown', 'toString']) {
    await ready(page, frame);
    assert.equal(await counter(), 'iter 000');
  }
  console.log('PASS: unknown/prototype frame names fall back to the resting frame');
  await ready(page, 'intro');
  assert.equal(await page.locator('body').getAttribute('data-intro'), 'running');
  assert.equal(await page.evaluate(() => getComputedStyle(document.body).overflow), 'hidden');
  await page.bringToFront();
  await page.goto('http://localhost:5173/');
  await page.waitForFunction(() => document.body.dataset.intro === 'done', null, { timeout: 8000 });
  assert.equal(await page.locator('body').getAttribute('data-ui'), 'on');
  console.log('PASS: intro runs, locks scroll, then hands over to the page');
  await page.locator('a.link').click();
  await page.waitForFunction(() => document.querySelector('#waitlist').classList.contains('on'));
  await page.locator('button[type=submit]').click();
  assert.equal(await page.locator('#email').evaluate(e => e.validity.valueMissing), true);
  await page.locator('#email').fill('not-an-email');
  await page.locator('button[type=submit]').click();
  assert.equal(await page.locator('#email').evaluate(e => e.validity.typeMismatch), true);
  await page.locator('#email').fill('hello@example.com');
  await page.locator('button[type=submit]').click();
  assert.match(await page.locator('#form-message').textContent(), /not stored/);
  console.log('PASS: waitlist link, invalid email rejection, honest demo success state');
  await page.locator('#sound').click();
  assert.equal(await page.locator('#sound').getAttribute('aria-pressed'), 'true');
  await page.locator('#sound').click();
  assert.equal(await page.locator('#sound').getAttribute('aria-pressed'), 'false');
  console.log('PASS: sound toggle');
  await page.locator('#about-toggle').click();
  await page.waitForFunction(() => document.querySelector('#about').classList.contains('on'));
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('#about').hidden);
  console.log('PASS: about window opens and closes with Escape');
  await ready(page);
  await page.waitForFunction(() => document.body.dataset.intro === 'done', null, { timeout: 8000 });
  const captions = [];
  for (const p of [.15, .3, .4, .5, .7, .8, .84, .88, .95]) { await page.evaluate(v => window.scrollTo(0, v * (document.documentElement.scrollHeight - innerHeight)), p); await page.waitForTimeout(900); captions.push(await page.locator('.tag').textContent()); }
  const stages = captions.map(c => c.split(' · ')[0]);
  assert.deepEqual(stages.slice(0, 4), ['an open-weights model, before it has seen your work', 'observe', 'evaluate', 'refine']);
  assert.ok(stages.slice(4).every((s, i) => i === stages.length - 5 ? s === 'your model. sent to mars.' : s === 'ascend'), String(stages));
  console.log('PASS: captions advance monotonically through close and finale');
  const reduced = await context.newPage();
  await reduced.emulateMedia({ reducedMotion: 'reduce' });
  await ready(reduced);
  assert.equal(await reduced.locator('body').getAttribute('data-intro'), 'done');
  await reduced.close();
  console.log('PASS: reduced motion skips the intro');
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const small = await phone.newPage();
  await ready(small, 'mid');
  assert.equal(await small.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await phone.close();
  console.log('PASS: 390px layout without horizontal overflow');
  const noGl = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fallback = await noGl.newPage();
  await fallback.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
  await ready(fallback, 'beauty');
  assert.equal(await fallback.locator('body').getAttribute('data-renderer'), 'fallback');
  assert.equal(await fallback.locator('#fallback').isVisible(), true);
  assert.equal(await fallback.locator('#access-form').count(), 1);
  await noGl.close();
  console.log('PASS: WebGL fallback keeps the outline and the form');
  assert.deepEqual(errors, []);
  console.log('PASS: zero console/page/HTTP errors');
} finally {
  await context.close();
  await browser.close();
}
