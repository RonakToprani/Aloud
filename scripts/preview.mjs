/**
 * Render a local HTML file to a PNG, for looking at design work outside the
 * app — logo sheets, cover treatments, type specimens.
 *
 *   node scripts/preview.mjs <input.html> <output.png> [width]
 */
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const input = resolve(process.argv[2]);
const output = resolve(process.argv[3] ?? 'preview.png');
const width = Number(process.argv[4] ?? 900);

await mkdir(dirname(output), { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width, height: 900, deviceScaleFactor: 2 });
await page.goto(`file://${input}`, { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
await new Promise((r) => setTimeout(r, 400));
await page.screenshot({ path: output, fullPage: true });
await browser.close();
console.log('wrote', output);
