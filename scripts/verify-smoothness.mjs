import puppeteer from 'puppeteer-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = 'http://localhost:3000';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

// Instrument onplay/onended assignments on every <audio> element so we can
// see actual playback gaps, not just network timing.
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

const synthStarts = [];
page.on('request', (req) => {
  if (req.url().includes('/api/speech/edge/synthesize')) {
    let text = null;
    try { text = JSON.parse(req.postData() || '{}').text; } catch {}
    synthStarts.push({ t: Date.now(), text });
  }
});

await page.goto(BASE, { waitUntil: 'networkidle0' });
await page.waitForSelector('h1');

await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Paste text').click());
await page.waitForSelector('textarea');
await page.evaluate(() => {
  const input = document.querySelector('input[placeholder*="article"]');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'Smoothness Test');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
// Deliberately short, choppy sentences — the worst case for hiding synthesis
// latency behind playback.
await page.evaluate((text) => {
  const ta = document.querySelector('textarea');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, text);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, 'Yes. No. Wait. Really? Stop. Go on. Fine then. That works. Almost done. Last one.');
await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Add to library').click());
await page.waitForSelector('ul li a', { timeout: 15000 });
await page.click('ul li a');
await page.waitForSelector('[class*="flow"]', { timeout: 15000 });
await new Promise(r => setTimeout(r, 800));

await page.evaluate(() => document.querySelector('button[aria-label="Voice and speed"]').click());
await new Promise(r => setTimeout(r, 1500));
await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[class*="voiceRow"]')];
  const row = rows.find((r) => r.querySelector('[class*="badge"]')?.textContent === 'Enhanced');
  row?.click();
});
await new Promise(r => setTimeout(r, 200));
await page.evaluate(() => document.querySelectorAll('[aria-label="Close"]').forEach(b => b.click()));
await new Promise(r => setTimeout(r, 200));

synthStarts.length = 0;
await page.evaluate(() => { window.__events = []; });
const playClickTime = Date.now();
await page.evaluate(() => document.querySelector('button[aria-label="Play"]')?.click());
await new Promise(r => setTimeout(r, 16000));

const events = await page.evaluate(() => window.__events);
console.log('AUDIO_EVENTS', JSON.stringify(events, null, 2));

// Compute gap between one sentence's "ended" and the next sentence's "play".
const gaps = [];
for (let i = 0; i < events.length - 1; i++) {
  if (events[i].type === 'ended' && events[i + 1]?.type === 'play') {
    gaps.push(Math.round(events[i + 1].t - events[i].t));
  }
}
console.log('GAPS_MS_BETWEEN_SENTENCES', JSON.stringify(gaps));
console.log('SYNTH_REQUESTS', synthStarts.length, JSON.stringify(synthStarts.map(s => s.text)));

await browser.close();
