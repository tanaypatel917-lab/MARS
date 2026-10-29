import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const browser = await chromium.connectOverCDP('http://localhost:29229');
const page = await browser.contexts()[0].newPage();
await page.setViewportSize({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
await fs.mkdir('shots', { recursive: true });
for (const frame of ['orbit', 'loop', 'arrival']) {
  await page.goto(`http://localhost:5173/?frame=${frame}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.waitForTimeout(1700);
  await page.screenshot({ path: `shots/${frame}.png` });
  console.log(frame, await page.locator('body').getAttribute('data-renderer'), await page.locator('body').getAttribute('data-chapter'));
}
for (const [name, progress] of [['orbit-launch-midpoint', .21], ['loop-approach-midpoint', .66]]) {
  await page.goto('http://localhost:5173/');
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.evaluate(p => window.scrollTo(0, p * (document.documentElement.scrollHeight - innerHeight)), progress);
  await page.waitForTimeout(1700);
  await page.screenshot({ path: `shots/${name}.png` });
}
await page.goto('http://localhost:5173/specimen.html');
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: 'shots/font-specimen.png' });
await fs.writeFile('shots/console.json', JSON.stringify(errors, null, 2));
console.log('Console/page errors:', errors.length, errors);
await page.close();
await browser.close();
