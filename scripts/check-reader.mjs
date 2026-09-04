/**
 * Opens a seeded book, then the Voice & speed sheet, and reports any page
 * errors. The voice picker is where the design work and the cloud-voice engine
 * both landed, so it is the most likely place for a clean merge to still be
 * semantically broken.
 */
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = process.argv[2] || 'screenshots/reader';

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`); });

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: 'networkidle0' });

// Each launch gets a clean profile, so add a book through the real import
// path rather than assuming one is already stored.
const PASSAGE = `Mrs. Dalloway said she would buy the flowers herself. For Lucy had her work cut out for her.

The doors would be taken off their hinges; Rumpelmayer's men were coming. And then, thought Clarissa Dalloway, what a morning.`;

await page.evaluate(() =>
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Paste text').click(),
);
await page.waitForSelector('textarea');
await page.evaluate((text) => {
  const set = (el, value) => {
    const proto = el.tagName === 'INPUT' ? HTMLInputElement : HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  set(document.querySelector('input[placeholder*="article"]'), 'Mrs Dalloway');
  set(document.querySelector('textarea'), text);
}, PASSAGE);
await page.evaluate(() =>
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add to library').click(),
);
await page.waitForSelector('a[href^="/read/"]', { timeout: 20000 });
await new Promise((r) => setTimeout(r, 500));

const link = await page.$('a[href^="/read/"]');
if (!link) {
  console.error('FAIL: no book in the library to open');
  await browser.close();
  process.exit(1);
}
await link.click();
await page.waitForSelector('[class*="flow"]', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 900));
await page.screenshot({ path: `${OUT}/reader.png` });

const controls = await page.evaluate(() =>
  ['Appearance', 'Voice and speed', 'Contents'].map((label) => ({
    label,
    present: Boolean(document.querySelector(`button[aria-label="${label}"]`)),
  })),
);
for (const c of controls) if (!c.present) errors.push(`missing control: ${c.label}`);

await page.evaluate(() => document.querySelector('button[aria-label="Voice and speed"]')?.click());
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: `${OUT}/voice-sheet.png` });

const sheet = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return null;
  return {
    title: dialog.getAttribute('aria-label'),
    voiceRows: dialog.querySelectorAll('[role="radio"]').length,
    text: (dialog.textContent || '').replace(/\s+/g, ' ').slice(0, 260),
  };
});

await browser.close();
console.log('controls:', controls.map((c) => `${c.label}=${c.present}`).join(' '));
console.log('voice sheet:', JSON.stringify(sheet, null, 2));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
process.exit(errors.length ? 1 : 0);
