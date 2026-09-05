/**
 * Generates the app icons from the same geometry as the in-app logo mark:
 * three lines of text with one word lit by the reading pill. No letters, no
 * fonts — just the shape — so the icon and the mark in the header are
 * demonstrably the same object.
 *
 *   node scripts/icons.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = resolve('public/icons');

// Fixed brand colours: an app icon does not follow the reader's theme. These
// are the dark theme's canvas, ink and word-pill tokens.
const CANVAS = 'oklch(0.235 0.011 250)';
const INK = 'oklch(0.86 0.008 250)';
const PILL = 'oklch(0.50 0.075 250)';

// Mirrors LOGO_GEOMETRY in src/components/ui/Logo.tsx.
const G = {
  viewBox: 32,
  stroke: 3.4,
  lines: [
    { y: 8, x1: 5, x2: 27 },
    { y: 24, x1: 5, x2: 21 },
  ],
  pill: { x: 5, y: 12.2, width: 13, height: 7.6, radius: 3.8 },
  tail: { y: 16, x1: 22, x2: 27 },
};

function markSvg(size) {
  const lines = [...G.lines, G.tail]
    .map(
      (l) =>
        `<path d="M${l.x1} ${l.y}H${l.x2}" stroke="${INK}" stroke-width="${G.stroke}" stroke-linecap="round"/>`,
    )
    .join('');
  const pill = `<rect x="${G.pill.x}" y="${G.pill.y}" width="${G.pill.width}" height="${G.pill.height}" rx="${G.pill.radius}" fill="${PILL}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${G.viewBox} ${G.viewBox}" fill="none">${lines}${pill}</svg>`;
}

/** `scale` is the mark's width as a fraction of the tile. */
function page(size, { scale = 0.6, radius = 0 } = {}) {
  const mark = size * scale;
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}
  .tile{width:${size}px;height:${size}px;background:${CANVAS};border-radius:${radius}px;
        display:flex;align-items:center;justify-content:center}
</style></head>
<body><div class="tile">${markSvg(mark)}</div></body></html>`;
}

const TARGETS = [
  { file: 'icon-512.png', size: 512, opts: {} },
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'apple-touch-icon.png', size: 180, opts: {} },
  // Maskable icons must survive an aggressive circular crop: keep the mark
  // inside the middle 80%.
  { file: 'icon-maskable-512.png', size: 512, opts: { scale: 0.5 } },
  // Favicons sit on every colour of browser chrome, so the tile stays and
  // the mark grows to stay legible at 16px.
  { file: 'favicon-32.png', size: 32, opts: { scale: 0.82, radius: 7 } },
  { file: 'favicon-16.png', size: 16, opts: { scale: 0.9, radius: 3.5 } },
];

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });

for (const { file, size, opts } of TARGETS) {
  const tab = await browser.newPage();
  await tab.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await tab.setContent(page(size, opts), { waitUntil: 'load' });
  const buffer = await tab.screenshot({ omitBackground: true });
  await writeFile(resolve(OUT, file), buffer);
  await tab.close();
  console.log(`  ${file.padEnd(26)} ${size}×${size}`);
}

await browser.close();
console.log('icons written to', OUT);
