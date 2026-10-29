import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';

const browser = await chromium.connectOverCDP('http://localhost:29229');
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
async function ready(target, frame = '') {
  await target.goto(`http://localhost:5173/${frame ? `?frame=${frame}` : ''}`);
  await target.waitForFunction(() => document.body.dataset.ready === 'true');
}
async function scroll(p) {
  await page.evaluate(value => window.scrollTo(0, value * (document.documentElement.scrollHeight - innerHeight)), p);
  await page.waitForTimeout(180);
}
try {
  for (const frame of ['orbit', 'loop', 'arrival']) {
    await ready(page, frame);
    assert.equal(await page.locator('body').getAttribute('data-renderer'), 'ready');
    assert.equal(await page.locator('body').getAttribute('data-chapter'), frame);
    assert.equal(await page.locator('.chapter:not([hidden])').count(), 1);
    assert.equal(await page.locator('canvas').count(), 1);
    const size = await page.locator('canvas').evaluate(c => [c.width, c.height]);
    assert(size[0] * size[1] <= 2_200_000);
  }
  console.log('PASS: 3 frame URLs, one canvas/active chapter, render pixel budget');
  for (const frame of ['unknown', 'toString']) {
    await ready(page, frame);
    assert.equal(await page.locator('body').getAttribute('data-chapter'), 'orbit');
  }
  console.log('PASS: unknown/prototype frame names safely retain Orbit');
  await ready(page);
  for (const [i, p] of [.425, .475, .525, .575].entries()) {
    await scroll(p);
    await page.waitForFunction(phase => document.body.dataset.phase === String(phase), i);
    assert.equal(await page.locator('#loop-title').textContent(), ['Observe', 'Evaluate', 'Refine', 'Ascend'][i]);
    assert.equal(await page.locator('.phase-track .active').count(), 1);
  }
  await scroll(.1);
  assert.equal(await page.locator('body').getAttribute('data-chapter'), 'orbit');
  assert.equal(await page.locator('.chapter:not([hidden])').count(), 1);
  console.log('PASS: 4 loop phases and reversible scroll without text ghosting');
  await page.locator('.nav-access').click();
  assert.equal(await page.locator('body').getAttribute('data-chapter'), 'arrival');
  await page.locator('button[type=submit]').click();
  assert.equal(await page.locator('#email').evaluate(e => e.validity.valueMissing), true);
  await page.locator('#email').fill('not-an-email');
  await page.locator('button[type=submit]').click();
  assert.equal(await page.locator('#email').evaluate(e => e.validity.typeMismatch), true);
  await page.locator('#email').fill('hello@example.com');
  await page.locator('button[type=submit]').click();
  assert.match(await page.locator('#form-message').textContent(), /NOT BEEN STORED/);
  console.log('PASS: nav jump/focus, empty/invalid email rejection, honest demo success state');
  const reduced = await context.newPage();
  await reduced.emulateMedia({ reducedMotion: 'reduce' });
  await ready(reduced, 'loop');
  const first = await reduced.locator('canvas').screenshot();
  await reduced.waitForTimeout(350);
  const second = await reduced.locator('canvas').screenshot();
  assert(first.equals(second), 'Reduced motion must render a static frame');
  await reduced.close();
  console.log('PASS: reduced-motion canvas remains pixel-identical');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const frame of ['orbit', 'loop', 'arrival']) {
    await ready(page, frame);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.screenshot({ path: 'shots/mobile-arrival.png' });
  console.log('PASS: 390px layout has no horizontal overflow in all 3 approval states');
  const fallback = await context.newPage();
  await fallback.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (String(type).startsWith('webgl')) return null;
      return original.call(this, type, ...args);
    };
  });
  await ready(fallback, 'arrival');
  assert.equal(await fallback.locator('body').getAttribute('data-renderer'), 'fallback');
  assert.equal(await fallback.locator('#email').isVisible(), true);
  await fallback.close();
  console.log('PASS: unavailable WebGL retains the DOM/form and static fallback');
  assert.deepEqual(errors, []);
  await fs.writeFile('shots/test-console.json', JSON.stringify(errors));
  console.log('PASS: 0 console/page/HTTP errors on supported WebGL path');
} finally {
  await context.close();
  await browser.close();
}
