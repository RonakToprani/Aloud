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

const PASSAGE = `Mrs. Dalloway said she would buy the flowers herself. For Lucy had her work cut out for her. The doors would be taken off their hinges; Rumpelmayer's men were coming. And then, thought Clarissa Dalloway, what a morning, fresh as if issued to children on a beach.

What a lark! What a plunge! For so it had always seemed to her when, with a little squeak of the hinges, which she could hear now, she had burst open the French windows and plunged at Bourton into the open air. How fresh, how calm, stiller than this of course, the air was in the early morning.

Like the flap of a wave; the kiss of a wave; chill and sharp and yet solemn, feeling as she did, standing there at the open window, that something awful was about to happen. She was looking at the flowers, at the trees with the smoke winding off them, and at the rooks rising and falling.`;

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
  // Record every synthesis request so the timeline shows when work started
  // relative to when the audio needed it.
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url ?? '';
    if (url.includes('/api/speech/edge/synthesize')) {
      let chars = 0;
      try { chars = JSON.parse(init.body).text.length; } catch {}
      const started = performance.now();
      window.__timeline.push({ t: started, type: 'request', chars });
      const response = await originalFetch(input, init);
      window.__timeline.push({ t: performance.now(), type: 'response', chars, took: Math.round(performance.now() - started) });
      return response;
    }
    return originalFetch(input, init);
  };

  const originalCreate = Ctx.prototype.createBufferSource;
  Ctx.prototype.createBufferSource = function createBufferSource() {
    const node = originalCreate.call(this);
    const originalStart = node.start.bind(node);
    node.start = (...args) => {
      // The looping source is the silence that keeps the MediaStream fed, not
      // a sentence; counting it would invent transitions that never happened.
      if (!node.loop) window.__timeline.push({ t: performance.now(), type: 'play' });
      return originalStart(...args);
    };
    node.addEventListener('ended', () => {
      if (!node.loop) window.__timeline.push({ t: performance.now(), type: 'ended' });
    });
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
await new Promise((r) => setTimeout(r, 60000));

const timeline = await page.evaluate(() => window.__timeline);
const starts = timeline.filter((e) => e.type === 'play').length;
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

console.log('audio sources started:', starts,
  '(one per passage when sentences are synthesised together, one per sentence otherwise)');
if (!gaps.length) {
  console.log('no source restarts between sentences at all — playback ran continuously');
  process.exit(0);
}
const t0 = timeline.length ? timeline[0].t : 0;
console.log('\ntimeline (ms from first event):');
for (const e of timeline) {
  const at = String(Math.round(e.t - t0)).padStart(6);
  if (e.type === 'request') console.log(`  ${at}  request  ${e.chars} chars`);
  else if (e.type === 'response') console.log(`  ${at}  arrived  ${e.chars} chars in ${e.took}ms`);
  else console.log(`  ${at}  ${e.type}`);
}

const sorted = [...gaps].sort((a, b) => a - b);
console.log('gaps between sentences (ms):', gaps.join(', '));
console.log('median:', sorted[Math.floor(sorted.length / 2)], 'ms   max:', sorted[sorted.length - 1], 'ms');
