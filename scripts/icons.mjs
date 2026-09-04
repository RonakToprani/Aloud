/**
 * Generates the app icons from the same geometry as the in-app logo.
 *
 * Rendered through headless Chrome rather than drawn by hand, so the 'a' is
 * the real Newsreader glyph and the corners are properly antialiased.
 *
 *   node scripts/icons.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = resolve('public/icons');

// Fixed brand colours: an app icon does not follow the reader's theme.
const CANVAS = 'oklch(0.235 0.011 250)';
const PILL = 'oklch(0.455 0.062 250)';
const INK = 'oklch(0.97 0.008 250)';
const ACCENT = 'oklch(0.70 0.075 250)';

/** `scale` is the pill width as a fraction of the tile. */
function page(size, { scale = 0.62, pill = true, radius = 0, glyph = 0.76 } = {}) {
  const w = size * scale;
  const h = w * 0.875;
  const fontSize = h * glyph;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Newsreader:wght@500&display=swap" rel="stylesheet">
<style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
  .tile{width:${size}px;height:${size}px;background:${CANVAS};border-radius:${radius}px;
        display:flex;align-items:center;justify-content:center}
  .pill{width:${w}px;height:${h}px;border-radius:${h * 0.32}px;background:${pill ? PILL : 'transparent'};
        display:flex;align-items:center;justify-content:center}
  .a{font-family:'Newsreader',Georgia,serif;font-weight:500;font-size:${fontSize}px;
     color:${pill ? INK : ACCENT};line-height:1;transform:translateY(${fontSize * 0.055}px)}
</style></head>
<body><div class="tile"><div class="pill"><span class="a">a</span></div></div></body></html>`;
}

const TARGETS = [
  { file: 'icon-512.png', size: 512, opts: {} },
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'apple-touch-icon.png', size: 180, opts: {} },
  // Maskable icons must survive an aggressive circular crop: keep the mark
  // inside the middle 80%.
  { file: 'icon-maskable-512.png', size: 512, opts: { scale: 0.48 } },
  // At favicon sizes a solid block holds up where a thin glyph on a dark
  // ground disappears, so the pill grows to fill the tile and carries the
  // letter itself. Browsers put favicons on every colour of chrome.
  { file: 'favicon-32.png', size: 32, opts: { scale: 0.94, glyph: 0.9 } },
  { file: 'favicon-16.png', size: 16, opts: { scale: 1, glyph: 0.94 } },
];

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

for (const { file, size, opts } of TARGETS) {
  const tab = await browser.newPage();
  await tab.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await tab.setContent(page(size, opts), { waitUntil: 'networkidle0' });
  await tab.evaluate(() => document.fonts.ready);
  const buffer = await tab.screenshot({ omitBackground: false });
  await writeFile(resolve(OUT, file), buffer);
  await tab.close();
  console.log(`  ${file.padEnd(26)} ${size}×${size}`);
}

await browser.close();
console.log('icons written to', OUT);
