/**
 * Regression check for the paste-sheet keyboard bug.
 *
 * The Sheet's focus effect used to depend on `onClose`, which the library
 * recreates every render. Every keystroke therefore tore the effect down and
 * re-ran it, moving focus back to the panel — which on iOS dismisses the
 * keyboard after each letter typed. Typing here and asserting focus never
 * leaves the input reproduces that from the outside.
 */
import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const TITLE = 'Mrs Dalloway';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844 });

const failures = [];
page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('h1');
await page.evaluate(() =>
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Paste text').click(),
);
await page.waitForSelector('input[placeholder*="article"]');

const selector = 'input[placeholder*="article"]';
await page.click(selector);

// Type one character at a time, checking focus survives each one.
for (const char of TITLE) {
  await page.keyboard.type(char, { delay: 25 });
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? `${el.tagName.toLowerCase()}${el.getAttribute('placeholder') ? '[title]' : ''}` : 'none';
  });
  if (focused !== 'input[title]') {
    failures.push(`focus left the title field after typing "${char}" (went to ${focused})`);
    break;
  }
}

const value = await page.$eval(selector, (el) => el.value);
if (value !== TITLE) failures.push(`title lost characters: expected ${JSON.stringify(TITLE)}, got ${JSON.stringify(value)}`);

// The same must hold for the body textarea.
await page.click('textarea');
await page.keyboard.type('Some text.', { delay: 15 });
const textareaFocused = await page.evaluate(() => document.activeElement?.tagName.toLowerCase());
if (textareaFocused !== 'textarea') failures.push(`focus left the textarea (went to ${textareaFocused})`);

await browser.close();

if (failures.length) {
  console.error('FAIL\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log(`PASS  typed ${TITLE.length} characters, focus never left the field`);
