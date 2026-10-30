// Contact sheet of the planet → wordmark morph: node scripts/sheet.mjs <label> [steps...]
// Needs the dev server on 5173 and Chrome CDP on 29229; writes shots/sheet-<label>.png (+ shots/morph-<label>-<p>.png).
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const label = process.argv[2] ?? 'now';
const steps = process.argv.slice(3).length ? process.argv.slice(3).map(Number) : Array.from({ length: 11 }, (_, i) => +(0.9 + i * 0.01).toFixed(2));
const wait = Number(process.env.SHEET_WAIT ?? 1600);
const browser = await chromium.connectOverCDP('http://localhost:29229');
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.bringToFront();
await page.goto('http://localhost:5173/');
await page.waitForFunction(() => document.body.dataset.intro === 'done', null, { timeout: 15000 });
await page.waitForTimeout(400);
await fs.mkdir('shots', { recursive: true });
const files = [];
for (const p of steps) {
  await page.evaluate(v => window.scrollTo(0, v * (document.documentElement.scrollHeight - innerHeight)), p);
  await page.waitForTimeout(wait);
  const file = `shots/morph-${label}-${p.toFixed(2)}.png`;
  await page.screenshot({ path: file });
  files.push(file);
  console.log(p.toFixed(2), file);
}
await context.close();
await browser.close();
execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw
import sys
label, files = sys.argv[1], sys.argv[2:]
steps = ${JSON.stringify(steps)}
cols = 4; scale = 0.5
ims = [Image.open(f).convert('RGB') for f in files]
w, h = int(ims[0].width * scale), int(ims[0].height * scale)
rows = -(-len(ims) // cols)
sheet = Image.new('RGB', (cols * w, rows * (h + 26)), (8, 7, 10))
d = ImageDraw.Draw(sheet)
for i, im in enumerate(ims):
    x, y = (i % cols) * w, (i // cols) * (h + 26)
    sheet.paste(im.resize((w, h), Image.LANCZOS), (x, y + 26))
    d.text((x + 8, y + 7), f'{label} · progress {steps[i]:.2f}', fill=(220, 210, 200))
sheet.save(f'shots/sheet-{label}.png')
print('wrote', f'shots/sheet-{label}.png', sheet.size)
`, label, ...files], { stdio: 'inherit' });
