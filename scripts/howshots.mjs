// usage: node howshots.mjs <port> <tag> [frames...]  — screenshots of /how frames on desktop + phone, plus frame-time samples
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
const [port = '5173', tag = 'after', ...rest] = process.argv.slice(2);
const frames = rest.length ? rest : ['loop', 'observe', 'evaluate', 'refine', 'ascend'];
const browser = await chromium.connectOverCDP('http://localhost:29229');
const out = `/home/ubuntu/repos/MARS/shots/${tag}`; await fs.mkdir(out, { recursive: true });
const errors = [];
async function run(viewport, label, extra = '') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(`${label} ${String(e)}`));
  page.on('console', m => { if (m.type() === 'error') errors.push(`${label} ${m.text()}`); });
  for (const frame of frames) {
    await page.goto(`http://localhost:${port}/how?frame=${frame}${extra}${process.env.TIER ? `&tier=${process.env.TIER}` : ''}`);
    await page.waitForFunction(() => document.body.dataset.ready === 'true');
    await page.waitForTimeout(3200);
    const ms = await page.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 > 2500) r((performance.now() - t0) / n); else requestAnimationFrame(f); }; requestAnimationFrame(f); }));
    const size = await page.locator('canvas#scene').evaluate(c => [c.width, c.height]);
    await page.screenshot({ path: `${out}/${label}-${frame}.png` });
    console.log(`${tag} ${label} ${frame}: ${ms.toFixed(1)} ms/frame, canvas ${size.join('x')}, tier ${await page.evaluate(() => document.body.dataset.tier ?? '-')}`);
  }
  await context.close();
}
await run({ width: 1440, height: 900 }, 'desktop');
await run({ width: 390, height: 844 }, 'phone');
console.log('errors:', errors);
await browser.close();
