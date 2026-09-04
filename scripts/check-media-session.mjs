/**
 * Verifies what the lock screen would show: the book (not the sentence), its
 * own cover, and a duration for the whole book.
 *
 *   node scripts/check-media-session.mjs
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE_URL || 'http://localhost:3000';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage();
const failures = [];
page.on('pageerror', (e) => failures.push(`page error: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') failures.push(`console: ${m.text().slice(0, 300)}`); });

// Capture the transport handlers so the lock-screen buttons can actually be
// pressed from here; there is no way to read them back off mediaSession.
// Also record what the page hands to setPositionState, for the same reason.
await page.evaluateOnNewDocument(() => {
  window.__handlers = {};
  window.__position = null;
  const armHandlers = setInterval(() => {
    if (!navigator.mediaSession?.setActionHandler) return;
    clearInterval(armHandlers);
    const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (action, handler) => {
      window.__handlers[action] = handler;
      return original(action, handler);
    };
  }, 10);
  window.__sourceStarts = 0;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) {
    const originalCreate = Ctx.prototype.createBufferSource;
    Ctx.prototype.createBufferSource = function createBufferSource() {
      const node = originalCreate.call(this);
      const originalStart = node.start.bind(node);
      node.start = (...args) => {
        window.__sourceStarts += 1;
        return originalStart(...args);
      };
      return node;
    };
  }
  const wait = setInterval(() => {
    if (!navigator.mediaSession?.setPositionState) return;
    clearInterval(wait);
    const original = navigator.mediaSession.setPositionState.bind(navigator.mediaSession);
    navigator.mediaSession.setPositionState = (state) => {
      window.__position = state;
      return original(state);
    };
  }, 10);
});

await page.setViewport({ width: 390, height: 844 });
await page.goto(BASE, { waitUntil: 'networkidle0' });

// A book with real cover art, so the artwork path is exercised.
await page.evaluate(async () => {
  // Create the stores here rather than waiting for the app to do it. Opening
  // the database first — at any version — makes it exist without them, and the
  // app's own open then sees a current version and never runs its upgrade.
  const db = await new Promise((res, rej) => {
    const request = indexedDB.open('aloud', 1);
    request.onupgradeneeded = () => {
      const d = request.result;
      if (!d.objectStoreNames.contains('books')) d.createObjectStore('books', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('bodies')) d.createObjectStore('bodies', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('bookmarks')) {
        d.createObjectStore('bookmarks', { keyPath: 'id' }).createIndex('bookId', 'bookId', { unique: false });
      }
    };
    request.onsuccess = () => res(request.result);
    request.onerror = () => rej(request.error);
  });
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 600;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#33415a';
  ctx.fillRect(0, 0, 400, 600);
  const cover = await new Promise((res) => canvas.toBlob(res, 'image/png'));

  const sentences = 40;
  const tx = db.transaction(['books', 'bodies'], 'readwrite');
  tx.objectStore('books').put({
    id: 'ms-test',
    title: 'Mrs Dalloway',
    author: 'Virginia Woolf',
    source: 'epub',
    addedAt: Date.now(),
    sentenceCount: sentences * 3,
    chapterTitles: ['The Window', 'Time Passes', 'The Lighthouse'],
    chapterSentenceCounts: [sentences, sentences, sentences],
    chapterWordCounts: [21000, 21000, 21000],
    wordCount: 63000,
    cover,
  });
  tx.objectStore('bodies').put({
    id: 'ms-test',
    chapters: ['The Window', 'Time Passes', 'The Lighthouse'].map((title, i) => ({
      id: `c${i}`,
      title,
      blocks: Array.from({ length: 12 }, () => ({
        kind: 'p',
        text: 'Mrs. Dalloway said she would buy the flowers herself, for Lucy had her work cut out for her, and the doors would be taken off their hinges before the morning was over.',
      })),
    })),
  });
  await new Promise((res) => { tx.oncomplete = res; });
});

await page.goto(`${BASE}/read/ms-test`, { waitUntil: 'networkidle0' });
try {
  await page.waitForSelector('[class*="flow"]', { timeout: 15000 });
} catch {
  const seen = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
  console.error('reader did not render. page said:', JSON.stringify(seen));
  const stored = await page.evaluate(async () => {
    const db = await new Promise((res) => { const r = indexedDB.open('aloud', 1); r.onsuccess = () => res(r.result); });
    const read = (store, id) => new Promise((res) => {
      const r = db.transaction(store).objectStore(store).get(id);
      r.onsuccess = () => res(r.result);
    });
    const meta = await read('books', 'ms-test');
    const body = await read('bodies', 'ms-test');
    return { hasMeta: !!meta, hasBody: !!body, chapters: body?.chapters?.length ?? 0, blocks: body?.chapters?.[0]?.blocks?.length ?? 0 };
  });
  console.error('stored:', JSON.stringify(stored));
  console.error('errors:', failures.join(' | ') || 'none');
  await browser.close();
  process.exit(1);
}
await new Promise((r) => setTimeout(r, 700));
await page.evaluate(() => document.querySelector('button[aria-label="Play"]')?.click());
await new Promise((r) => setTimeout(r, 4000));

// Press pause and then play the way the lock screen would, and check that
// audio actually starts again rather than the session quietly dying.
const transport = await page.evaluate(async () => {
  const sourcesBefore = window.__sourceStarts ?? 0;
  window.__handlers.pause?.();
  await new Promise((r) => setTimeout(r, 1200));
  const stateWhilePaused = navigator.mediaSession.playbackState;
  window.__handlers.play?.();
  await new Promise((r) => setTimeout(r, 2500));
  return {
    hadHandlers: Boolean(window.__handlers.play && window.__handlers.pause),
    stateWhilePaused,
    stateAfterPlay: navigator.mediaSession.playbackState,
    startedAgain: (window.__sourceStarts ?? 0) > sourcesBefore,
    metadataStillThere: Boolean(navigator.mediaSession.metadata),
  };
});

const result = await page.evaluate(() => {
  const m = navigator.mediaSession?.metadata;
  return {
    title: m?.title ?? null,
    artist: m?.artist ?? null,
    album: m?.album ?? null,
    artwork: m?.artwork?.[0]?.src?.slice(0, 5) ?? null,
    playbackState: navigator.mediaSession?.playbackState ?? null,
    position: window.__position,
  };
});

await browser.close();

const hours = result.position ? (result.position.duration / 3600).toFixed(2) : null;
console.log('lock screen would show:');
console.log('  title  :', result.title);
console.log('  artist :', result.artist);
console.log('  album  :', result.album);
console.log('  artwork:', result.artwork === 'blob:' ? "the book's own cover" : result.artwork);
console.log('  state  :', result.playbackState);
console.log('  duration:', hours ? `${hours} hours (whole book)` : 'not set');
console.log('  position:', result.position ? `${Math.round(result.position.position)}s` : 'not set');

if (result.title !== 'Mrs Dalloway') failures.push(`title should be the book, got ${result.title}`);
if (result.artwork !== 'blob:') failures.push('artwork should be the book cover');
if (!result.position) failures.push('no position state was published');
else if (result.position.duration < 3600) failures.push(`duration looks like a sentence, not a book: ${result.position.duration}s`);

console.log('\nlock-screen transport:');
console.log('  handlers registered :', transport.hadHandlers);
console.log('  state while paused  :', transport.stateWhilePaused);
console.log('  state after play    :', transport.stateAfterPlay);
console.log('  audio resumed       :', transport.startedAgain);
console.log('  notification kept   :', transport.metadataStillThere);

if (!transport.hadHandlers) failures.push('no media session handlers were registered');
if (transport.stateWhilePaused !== 'paused') failures.push(`playbackState should be paused, got ${transport.stateWhilePaused}`);
if (!transport.startedAgain) failures.push('pressing play on the notification did not restart audio');
if (!transport.metadataStillThere) failures.push('the notification lost its metadata after a pause');

console.log(failures.length ? '\nFAIL\n  - ' + failures.join('\n  - ') : '\nPASS');
process.exit(failures.length ? 1 : 0);
