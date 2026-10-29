import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('public/fonts', { recursive: true });
for (const [family, weight, name] of [['switzer', '500', 'Switzer-Medium'], ['general-sans', '400', 'GeneralSans-Regular']]) {
  const css = await fetch(`https://api.fontshare.com/v2/css?f[]=${family}@${weight}&display=swap`);
  if (!css.ok) throw new Error(`Fontshare CSS: ${css.status}`);
  const url = (await css.text()).match(/url\('([^']+\.woff2)'\)/)?.[1];
  if (!url || new URL(`https:${url}`).hostname !== 'cdn.fontshare.com') throw new Error('Unexpected Fontshare WOFF2 source');
  const font = await fetch(`https:${url}`);
  if (!font.ok) throw new Error(`Fontshare binary: ${font.status}`);
  const bytes = Buffer.from(await font.arrayBuffer());
  if (bytes.subarray(0, 4).toString() !== 'wOF2') throw new Error('Invalid WOFF2 response');
  await writeFile(`public/fonts/${name}.woff2`, bytes);
  console.log(`Self-hosted ${name}: ${bytes.length} bytes`);
}
