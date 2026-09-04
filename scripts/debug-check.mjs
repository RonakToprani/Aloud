import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.evaluateOnNewDocument(() => {
  window.__events = [];
  const OrigAudio = window.Audio;
  window.Audio = new Proxy(OrigAudio, {
    construct(target, args) {
      const instance = new target(...args);
      for (const type of ['play', 'ended']) {
        instance.addEventListener(type, () => window.__events.push({ type, t: performance.now() }));
      }
      return instance;
    },
  });
});
await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
await page.waitForSelector('h1');
const buttons = await page.evaluate(() => [...document.querySelectorAll('button')].map(b => b.textContent.trim()));
console.log('BUTTONS', buttons);
console.log('PAGE_ERRORS', errors);
await browser.close();
