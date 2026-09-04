/**
 * Seeds a realistic library straight into IndexedDB and photographs the app,
 * so design work can be judged against real content rather than one pasted
 * paragraph.
 *
 *   node scripts/seed-and-shoot.mjs [outDir]
 */
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const OUT = process.argv[2] || 'screenshots/library';

const BOOKS = [
  { title: 'Mrs Dalloway', author: 'Virginia Woolf', words: 63000, chapters: 8, cover: ['#2f3b52', '#6d7f9c'], progress: 0.34 },
  { title: 'The Waves', author: 'Virginia Woolf', words: 71000, chapters: 9, cover: ['#4a3b52', '#8a6f9c'], progress: 0 },
  { title: 'Wuthering Heights', author: 'Emily Brontë', words: 107000, chapters: 34, cover: null, progress: 0.82 },
  { title: 'The Waste Land and Other Poems', author: 'T. S. Eliot', words: 9000, chapters: 5, cover: ['#52432f', '#9c8a6f'], progress: 1 },
  { title: 'A Room of One’s Own', author: 'Virginia Woolf', words: 38000, chapters: 6, cover: null, progress: 0 },
  { title: 'Notes on a scanned article', author: null, words: 1400, chapters: 1, cover: null, progress: 0.12 },
];

await mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));

await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: 'networkidle0' });

await page.evaluate(async (books) => {
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

  async function makeCover([from, to]) {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 400, 600);
    grad.addColorStop(0, from);
    grad.addColorStop(1, to);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 400, 600);
    ctx.fillStyle = 'rgba(255,255,255,.9)';
    ctx.fillRect(46, 92, 120, 3);
    return new Promise((res) => canvas.toBlob(res, 'image/png'));
  }

  // Every cover has to exist before the transaction opens: awaiting anything
  // that is not an IndexedDB request lets the transaction auto-commit.
  const covers = await Promise.all(books.map((b) => (b.cover ? makeCover(b.cover) : null)));

  const tx = db.transaction(['books', 'bodies'], 'readwrite');
  for (let i = 0; i < books.length; i++) {
    const b = books[i];
    const id = `seed-${i}`;
    const perChapter = Math.round(b.words / b.chapters);
    const sentencesPer = Math.max(1, Math.round(perChapter / 15));
    const meta = {
      id,
      title: b.title,
      author: b.author,
      source: 'epub',
      addedAt: Date.now() - i * 86400000,
      sentenceCount: sentencesPer * b.chapters,
      chapterTitles: Array.from({ length: b.chapters }, (_, c) => `Chapter ${c + 1}`),
      chapterSentenceCounts: Array.from({ length: b.chapters }, () => sentencesPer),
      chapterWordCounts: Array.from({ length: b.chapters }, () => perChapter),
      wordCount: b.words,
      cover: covers[i] ?? undefined,
    };
    tx.objectStore('books').put(meta);
    tx.objectStore('bodies').put({
      id,
      chapters: [{ id: 'c0', title: 'Chapter 1', blocks: [{ kind: 'p', text: 'Placeholder body.' }] }],
    });

    if (b.progress > 0) {
      const target = Math.floor(meta.sentenceCount * b.progress);
      localStorage.setItem(
        `aloud.position.${id}`,
        JSON.stringify({
          chapterIndex: Math.min(b.chapters - 1, Math.floor(target / sentencesPer)),
          sentenceIndex: target % sentencesPer,
          wordIndex: 0,
          updatedAt: Date.now() - i * 3600000,
        }),
      );
    }
  }
  await new Promise((res) => { tx.oncomplete = res; });
}, BOOKS);

const shots = [
  { name: 'phone-dark', width: 390, height: 844, theme: 'dark' },
  { name: 'phone-light', width: 390, height: 844, theme: 'light' },
  { name: 'desktop-dark', width: 1280, height: 900, theme: 'dark' },
];

for (const shot of shots) {
  await page.setViewport({ width: shot.width, height: shot.height, deviceScaleFactor: 2 });
  await page.evaluate((theme) => {
    const settings = JSON.parse(localStorage.getItem('aloud.settings.v1') || '{}');
    settings.theme = theme;
    localStorage.setItem('aloud.settings.v1', JSON.stringify(settings));
  }, shot.theme);
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);
  await new Promise((r) => setTimeout(r, 900));
  await page.screenshot({ path: `${OUT}/${shot.name}.png`, fullPage: true });
  console.log('shot', shot.name);
}

await browser.close();
console.log(errors.length ? 'PAGE ERRORS:\n' + errors.join('\n') : 'no page errors');
