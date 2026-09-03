import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:3000';
const OUT = process.env.SHOT_DIR || new URL('../screenshots/', import.meta.url).pathname;
const PASSAGE = `Mrs. Dalloway said she would buy the flowers herself. For Lucy had her work cut out for her.

The doors would be taken off their hinges; Rumpelmayer's men were coming. And then, thought Clarissa Dalloway, what a morning — fresh as if issued to children on a beach.

What a lark! What a plunge! For so it had always seemed to her when, with a little squeak of the hinges, which she could hear now, she had burst open the French windows and plunged at Bourton into the open air.`;

await (await import('node:fs/promises')).mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('h1');
await new Promise(r => setTimeout(r, 600));
await page.screenshot({ path: `${OUT}/01-library-empty.png` });

// Add a book through the paste sheet, exactly as a person would.
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Paste text').click());
await page.waitForSelector('textarea');
await page.evaluate(() => {
  const input = document.querySelector('input[placeholder*="article"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Mrs Dalloway');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.evaluate((text) => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, PASSAGE);
await new Promise(r => setTimeout(r, 200));
await page.screenshot({ path: `${OUT}/02-paste-sheet.png` });
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add to library').click());
await page.waitForSelector('ul li a', { timeout: 15000 });
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: `${OUT}/03-library-one-book.png` });

await page.click('ul li a');
await page.waitForSelector('[class*="flow"]', { timeout: 15000 });
await new Promise(r => setTimeout(r, 900));
await page.screenshot({ path: `${OUT}/04-reader-dark.png` });

// Appearance sheet
await page.evaluate(() => document.querySelector('button[aria-label="Appearance"]').click());
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: `${OUT}/05-appearance.png` });

// Every theme, on the reading surface itself.
for (const theme of ['warm', 'light', 'sepia']) {
  await page.evaluate((t) => {
    const label = { warm: 'Warm', light: 'Light', sepia: 'Sepia' }[t];
    [...document.querySelectorAll('button')].find(b => b.textContent.includes(label)).click();
  }, theme);
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: `${OUT}/06-theme-${theme}.png` });
}
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Dark')).click());
await page.evaluate(() => document.querySelector('button[aria-label="Close"]').click());
await new Promise(r => setTimeout(r, 500));

// Voice & speed sheet
await page.evaluate(() => document.querySelector('button[aria-label="Voice and speed"]').click());
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: `${OUT}/07-playback.png` });
await page.evaluate(() => document.querySelector('button[aria-label="Close"]').click());
await new Promise(r => setTimeout(r, 400));

// Contents
await page.evaluate(() => document.querySelector('button[aria-label="Contents"]').click());
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: `${OUT}/08-contents.png` });
await page.evaluate(() => document.querySelector('button[aria-label="Close"]').click());
await new Promise(r => setTimeout(r, 400));

// Desktop width
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: `${OUT}/09-reader-desktop.png` });
await page.goto(BASE, { waitUntil: 'networkidle0' });
await new Promise(r => setTimeout(r, 700));
await page.screenshot({ path: `${OUT}/10-library-desktop.png` });

console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
