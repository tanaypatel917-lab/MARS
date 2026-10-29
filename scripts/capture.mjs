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
for (const frame of process.argv.slice(2).length ? process.argv.slice(2) : ['intro', 'rest', 'mid', 'beauty']) {
  await page.goto(`http://localhost:5173/?frame=${frame}`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `shots/g-${frame}.png` });
  console.log(frame, await page.locator('body').getAttribute('data-renderer'), await page.locator('#counter').textContent());
}
console.log('errors:', errors);
await page.close();
await browser.close();
