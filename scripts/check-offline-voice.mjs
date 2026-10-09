/**
 * Drives the offline voice through the real reader.
 *
 * Needs a production build and a connection the first time, for the model
 * (about 92 MB from the Hugging Face hub, kept by the browser afterwards).
 * Adds a book, chooses the offline voice, presses play, and watches the
 * audio clock: the test is whether buffers get scheduled and the words are
 * paced, not whether anyone hears them. Then reloads and plays again, which
 * must come from the clip store rather than the model. Run as
 *
 *   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= npm run build
 *   node scripts/check-offline-voice.mjs
 *   VOICE=piper:en_US-amy-medium node scripts/check-offline-voice.mjs   # the light model
 */
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT || 3100);
const BASE = `http://localhost:${PORT}`;
const OUT = process.argv[2] || "screenshots/offline-voice";
const PROFILE = process.env.PROFILE_DIR || `${OUT}/profile${process.env.BACKEND ? `-${process.env.BACKEND}` : ""}${process.env.VOICE ? `-${process.env.VOICE.replace(/[^a-z0-9]/gi, "_")}` : ""}`;
const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS || 10 * 60 * 1000);

await mkdir(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server = null;
async function startServer() {
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore", detached: true });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("next start did not come up");
}
function stopServer() {
  if (!server) return;
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch {
    server.kill("SIGTERM");
  }
  server = null;
}

await startServer();
// The profile persists across runs so the model is downloaded once.
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  userDataDir: PROFILE,
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});
const failures = [];
const log = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};

const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
const scheduled = [];
const workerFiles = new Set();
page.on("console", (m) => {
  const text = m.text();
  if (text.startsWith("[sched]")) scheduled.push(JSON.parse(text.slice(7)));
  // The worker's own log arrives here too: which clips came from the store
  // and which were rendered, with timings. Printed when VERBOSE is set.
  else if (text.startsWith("[kokoro]") || text.startsWith("[piper]")) {
    if (process.env.VERBOSE) console.log(`     ${text}`);
  } else if (m.type() === "error") console.log(`     console: ${text.slice(0, 200)}`);
});
page.on("pageerror", (e) => console.log(`     page error: ${e.message.slice(0, 200)}`));

page.on("request", (r) => {
  const url = r.url();
  if (/huggingface|\/ort\/|wasm|_next\/static\/chunks\/\d+\./.test(url)) workerFiles.add(url.replace(BASE, ""));
});

// Every buffer that reaches the audio clock is logged with when it starts.
await page.evaluateOnNewDocument(() => {
  const original = AudioContext.prototype.createBufferSource;
  AudioContext.prototype.createBufferSource = function () {
    const source = original.call(this);
    const start = source.start.bind(source);
    const ctx = this;
    source.start = (when = ctx.currentTime, offset = 0) => {
      if (!source.loop && source.buffer) {
        console.log(
          `[sched]${JSON.stringify({ when: +when.toFixed(3), offset: +offset.toFixed(3), seconds: +source.buffer.duration.toFixed(2), now: +ctx.currentTime.toFixed(3), rate: source.buffer.sampleRate })}`,
        );
      }
      return start(when, offset);
    };
    return source;
  };
});

/* ---------------- a book, and the offline voice chosen for it ------------ */
await page.goto(BASE, { waitUntil: "networkidle0" });
await page.evaluate(() => {
  for (const key of Object.keys(localStorage)) if (key.startsWith("aloud.")) localStorage.removeItem(key);
});
await page.goto(BASE, { waitUntil: "networkidle0" });

const PASSAGE = `The Offline Reader

It was a bright cold day in April, and the clocks were striking thirteen. Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions.

The hallway smelt of boiled cabbage and old rag mats. At one end of it a coloured poster, too large for indoor display, had been tacked to the wall. It depicted simply an enormous face, more than a metre wide.`;

// The profile persists, so on a second run the book is already here.
const haveBook = await page.$('a[href^="/read/"]');
if (!haveBook) {
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Paste text").click());
await page.waitForSelector("textarea");
await page.evaluate((text) => {
  const set = (el, value) => {
    const proto = el.tagName === "INPUT" ? HTMLInputElement : HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set(document.querySelector('input[placeholder*="article"]'), "Nineteen Eighty-Four");
  set(document.querySelector("textarea"), text);
}, PASSAGE);
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add to library").click());
await page.waitForSelector('a[href^="/read/"]', { timeout: 20000 });
}
const readerHref = await page.$eval('a[href^="/read/"]', (a) => a.getAttribute("href"));
const bookId = readerHref.split("/").pop();

await page.evaluate((id, backend, voiceId) => {
  // BACKEND=wasm runs the CPU model even where a GPU is on offer.
  if (backend === "wasm") localStorage.setItem("aloud.offlineVoice.v1", JSON.stringify({ avoid: "webgpu" }));
  const settings = JSON.parse(localStorage.getItem("aloud.settings.v1") || "{}");
  settings.voiceId = voiceId;
  settings.rate = 1;
  settings.updatedAt = Date.now();
  localStorage.setItem("aloud.settings.v1", JSON.stringify(settings));
  localStorage.setItem("aloud.voiceChosen.v1", JSON.stringify([id]));
  localStorage.setItem("aloud.coach.v1", JSON.stringify("done"));
}, bookId, process.env.BACKEND || "", process.env.VOICE || "kokoro:af_heart");

await page.goto(`${BASE}${readerHref}`, { waitUntil: "networkidle0" });
await page.waitForSelector('button[aria-label="Play"]', { timeout: 20000 });

/* ---------------- first play: the model arrives, then speaks ------------- */
const t0 = Date.now();
await page.click('button[aria-label="Play"]');
const bannerSeen = await page
  .waitForFunction(() => /Getting the offline voice ready/.test(document.body.innerText), { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
log(bannerSeen, "the reader says the offline voice is being fetched");

const spoke = await page
  .waitForFunction(() => document.querySelector('button[aria-label="Pause"]') && !/Getting the offline voice ready/.test(document.body.innerText), {
    timeout: MODEL_TIMEOUT_MS,
  })
  .then(() => true)
  .catch(() => false);
log(spoke, `the model loaded and the banner cleared (${Math.round((Date.now() - t0) / 1000)}s)`);
await page.screenshot({ path: `${OUT}/playing.png` });

await page.waitForFunction(() => window.__aloudSched !== undefined || true, { timeout: 1000 }).catch(() => {});
// Give it time to schedule at least two passages.
const started = Date.now();
while (scheduled.length < 2 && Date.now() - started < 120_000) await sleep(500);
log(scheduled.length >= 1, `audio was scheduled on the clock (${scheduled.length} buffer(s))`);
if (scheduled.length) {
  log(scheduled[0].rate === 24000, `the model's 24 kHz buffers are used as they are (saw ${scheduled[0].rate})`);
  log(scheduled[0].seconds > 1, `the first passage is a real clip (${scheduled[0].seconds}s)`);
}
if (scheduled.length >= 2) {
  // Cold: the opening passage is a sentence or so and the next is still
  // being rendered when it ends, so a gap here is the model's speed, not a
  // fault. Reported, not judged; the warm run below is judged.
  const [a, b] = scheduled;
  console.log(`     cold seam between the first two passages: ${(b.when - (a.when + a.seconds)).toFixed(2)}s`);
}
const stillPlaying = await page.$('button[aria-label="Pause"]');
log(!!stillPlaying, "the reader is still playing after the first passage");

// The highlight follows the words: the player's sync mode leaves "pending".
const lit = await page.evaluate(() => !!document.querySelector('[class*="highlight"], [class*="pill"], [class*="wash"]'));
log(lit, "a word is highlighted while the offline voice reads");
await page.screenshot({ path: `${OUT}/reading.png` });

// A worker's fetches do not show on the page, but the service worker sees
// them, and keeps the runtime under /ort/ like any versioned asset.
const wasmFrom = await page.evaluate(async () => {
  const cache = await caches.open("aloud-assets-v2");
  return (await cache.keys()).map((r) => new URL(r.url).pathname).filter((p) => /\/ort\/|\.wasm$/.test(p));
});
log(wasmFrom.some((u) => u.startsWith("/ort/")), `onnxruntime came from our own origin, not a CDN (${wasmFrom.join(", ") || "nothing cached"})`);
log(![...workerFiles].some((u) => u.includes("jsdelivr")), "nothing was fetched from jsdelivr");
const modelFiles = await page.evaluate(async () => {
  const cache = await caches.open("transformers-cache");
  return (await cache.keys()).map((r) => r.url.split("/").pop()).filter((n) => n.endsWith(".onnx"));
});
console.log(`     model files on this device: ${modelFiles.join(", ")}`);

/* ---------------- second play: from the clip store -------------------- */
await page.click('button[aria-label="Pause"]');
await sleep(300);
scheduled.length = 0;
await page.reload({ waitUntil: "networkidle0" });
await page.waitForSelector('button[aria-label="Play"]', { timeout: 20000 });
const t1 = Date.now();
await page.click('button[aria-label="Play"]');
const resumed = await page
  .waitForFunction(() => document.querySelector('button[aria-label="Pause"]') && !/Getting the offline voice ready/.test(document.body.innerText), {
    timeout: 120_000,
  })
  .then(() => true)
  .catch(() => false);
while (scheduled.length < 1 && Date.now() - t1 < 60_000) await sleep(250);
const firstSoundMs = scheduled.length ? Date.now() - t1 : null;
log(resumed && scheduled.length >= 1, `after a reload the voice reads again (first sound after ${firstSoundMs} ms)`);
// Warm: every clip is in the store, so the next passage must be on the
// clock before the first one ends, and the seam is exactly the pause owed.
while (scheduled.length < 2 && Date.now() - t1 < 60_000) await sleep(250);
if (scheduled.length >= 2) {
  const [a, b] = scheduled;
  const seam = b.when - (a.when + a.seconds);
  log(seam >= 0.3 && seam <= 0.8, `warm: the second passage sits on the seam of the first (gap ${seam.toFixed(2)}s)`);
  log(b.now < a.when + a.seconds, `warm: it was scheduled before the first ran out (${(a.when + a.seconds - b.now).toFixed(2)}s early)`);
} else {
  log(false, "warm: a second passage was scheduled");
}
await page.screenshot({ path: `${OUT}/resumed.png` });

await browser.close();
stopServer();

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed. Screenshots in ${OUT}/`);
  process.exit(1);
}
console.log(`\nAll offline voice checks passed. Screenshots in ${OUT}/`);
