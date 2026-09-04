/**
 * Measures the silence between sentences when a cloud voice is selected.
 *
 * Cloud audio is scheduled through Web Audio, so the timing lives on the
 * buffer sources rather than on any element. Wrapping createBufferSource
 * before the app boots is the only way to observe it.
 *
 *   node scripts/measure-gap.mjs [voiceId]
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const VOICE = process.argv[2] || 'edge:en-GB-SoniaNeural';

const PASSAGE = `Mrs. Dalloway said she would buy the flowers herself. For Lucy had her work cut out for her. The doors would be taken off their hinges. Rumpelmayer's men were coming. And then, thought Clarissa Dalloway, what a morning.`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));

// Cloud audio plays through Web Audio, so the buffer sources are what carry
// the timing; the only <audio> element left is the silent session holder.
await page.evaluateOnNewDocument(() => {
  window.__timeline = [];
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const originalCreate = Ctx.prototype.createBufferSource;
  Ctx.prototype.createBufferSource = function createBufferSource() {
    const node = originalCreate.call(this);
    const originalStart = node.start.bind(node);
    node.start = (...args) => {
      window.__timeline.push({ t: performance.now(), type: 'play' });
      return originalStart(...args);
    };
    node.addEventListener('ended', () => window.__timeline.push({ t: performance.now(), type: 'ended' }));
    return node;
  };
});

await page.setViewport({ width: 390, height: 844 });
await page.goto(BASE, { waitUntil: 'networkidle0' });

// Pick the cloud voice up front so playback never touches a device voice.
await page.evaluate((voiceId) => {
  const s = JSON.parse(localStorage.getItem('aloud.settings.v1') || '{}');
  s.voiceId = voiceId;
  s.rate = 1;
  localStorage.setItem('aloud.settings.v1', JSON.stringify(s));
}, VOICE);

await page.goto(BASE, { waitUntil: 'networkidle0' });
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
  set(document.querySelector('input[placeholder*="article"]'), 'Gap test');
  set(document.querySelector('textarea'), text);
}, PASSAGE);
await page.evaluate(() =>
  [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add to library').click(),
);
await page.waitForSelector('a[href^="/read/"]', { timeout: 20000 });
await (await page.$('a[href^="/read/"]')).click();
await page.waitForSelector('[class*="flow"]', { timeout: 15000 });
await new Promise((r) => setTimeout(r, 800));

await page.evaluate(() => window.__timeline.splice(0));
await page.evaluate(() => document.querySelector('button[aria-label="Play"]')?.click());
await new Promise((r) => setTimeout(r, 30000));

const timeline = await page.evaluate(() => window.__timeline);
await browser.close();

// Pair each natural end with the start that follows it.
const gaps = [];
let lastEnded = null;
for (const event of timeline) {
  if (event.type === 'ended') lastEnded = event.t;
  else if (event.type === 'play' && lastEnded !== null) {
    gaps.push(Math.round(event.t - lastEnded));
    lastEnded = null;
  }
}

if (!gaps.length) {
  console.error('FAIL: no sentence transitions observed — did playback start?');
  console.error(JSON.stringify(timeline.slice(0, 10), null, 2));
  process.exit(1);
}
const sorted = [...gaps].sort((a, b) => a - b);
console.log('gaps between sentences (ms):', gaps.join(', '));
console.log('median:', sorted[Math.floor(sorted.length / 2)], 'ms   max:', sorted[sorted.length - 1], 'ms');
