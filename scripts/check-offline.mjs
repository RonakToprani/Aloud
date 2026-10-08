/**
 * Proves the installed app opens with no connection.
 *
 * Needs a production build (the service worker is not registered in
 * development). Starts `next start` itself, visits the library once online,
 * adds a book, opens it, then stops the server and reloads the library, the
 * reader and a never-visited reader URL, reporting what each one rendered.
 * The server really is stopped rather than the browser told it is offline:
 * Chrome's offline emulation does not reach the service worker's own
 * fetches, so an emulated run passes with the network still in use. Run as
 *
 *   NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_ANON_KEY= npm run build
 *   node scripts/check-offline.mjs
 */
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.PORT || 3100);
const BASE = `http://localhost:${PORT}`;
const OUT = process.argv[2] || "screenshots/offline";

await mkdir(OUT, { recursive: true });

let server = null;
async function startServer() {
  server = spawn("npx", ["next", "start", "-p", String(PORT)], { stdio: "ignore", detached: true });
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(BASE);
      if (res.ok) return;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await startServer();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const failures = [];
const log = (ok, message) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  if (!ok) failures.push(message);
};
page.on("pageerror", (e) => console.log(`     page error: ${e.message.slice(0, 160)}`));
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });

/* ---------------- online: first visit, which installs the worker ------- */
await page.goto(BASE, { waitUntil: "networkidle0" });
const registered = await page.evaluate(async () => {
  const registration = await navigator.serviceWorker.ready;
  // Installation caches the library and its assets; give it a moment.
  for (let i = 0; i < 50 && !(await caches.has("aloud-shell-v2")); i++) await new Promise((r) => setTimeout(r, 100));
  return !!registration.active;
});
log(registered, "service worker registered on first visit");

const PASSAGE = `Mrs. Dalloway said she would buy the flowers herself. For Lucy had her work cut out for her.

The doors would be taken off their hinges; Rumpelmayer's men were coming. And then, thought Clarissa Dalloway, what a morning.`;

await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Paste text").click());
await page.waitForSelector("textarea");
await page.evaluate((text) => {
  const set = (el, value) => {
    const proto = el.tagName === "INPUT" ? HTMLInputElement : HTMLTextAreaElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  set(document.querySelector('input[placeholder*="article"]'), "Mrs Dalloway");
  set(document.querySelector("textarea"), text);
}, PASSAGE);
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add to library").click());
await page.waitForSelector('a[href^="/read/"]', { timeout: 20000 });
const readerHref = await page.$eval('a[href^="/read/"]', (a) => a.getAttribute("href"));

// The shelf asks the worker to keep the reader page; wait for it to land.
const readerCached = await page.evaluate(async (href) => {
  for (let i = 0; i < 100; i++) {
    const hit = await caches.match(new URL(href, location.origin).toString(), { cacheName: "aloud-shell-v2" });
    if (hit) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}, readerHref);
log(readerCached, `reader page ${readerHref} cached without ever being navigated to`);

/* ---------------- offline: the server is gone -------------------------- */
stopServer();
await sleep(500);
let reachable = true;
try {
  await fetch(BASE);
} catch {
  reachable = false;
}
log(!reachable, "server stopped");

await page.goto(BASE, { waitUntil: "load" }).catch((e) => log(false, `library offline: ${e.message}`));
await sleep(800);
const libraryTitle = await page.evaluate(() => document.querySelector('a[href^="/read/"]')?.textContent?.trim() ?? "");
await page.screenshot({ path: `${OUT}/library-offline.png` });
log(libraryTitle.includes("Mrs Dalloway"), `library renders the shelf offline (saw "${libraryTitle.slice(0, 40)}")`);

await page.goto(`${BASE}${readerHref}`, { waitUntil: "load" }).catch((e) => log(false, `reader offline: ${e.message}`));
await page.waitForSelector('[class*="flow"]', { timeout: 15000 }).catch(() => {});
await sleep(800);
const readerText = await page.evaluate(() => document.body.innerText);
await page.screenshot({ path: `${OUT}/reader-offline.png` });
log(readerText.includes("buy the flowers herself"), "reader shows the book's text offline");
log(/Pause|Play/.test(readerText) || !!(await page.$('button[aria-label="Play"], button[aria-label="Pause"]')), "reader controls present offline");

// A reader URL never visited and never on the shelf: the library, not a blank page.
await page.goto(`${BASE}/read/never-seen`, { waitUntil: "load" }).catch((e) => log(false, `unknown page offline: ${e.message}`));
await sleep(500);
const landed = await page.evaluate(() => location.pathname);
log(landed === "/", `an unknown page offline lands on the library (at ${landed})`);

// A soft navigation from the shelf to the book, still offline.
await page.goto(BASE, { waitUntil: "load" });
await page.waitForSelector('a[href^="/read/"]', { timeout: 10000 });
await page.click('a[href^="/read/"]');
await page.waitForSelector('[class*="flow"]', { timeout: 15000 }).catch(() => {});
await sleep(800);
const softText = await page.evaluate(() => `${location.pathname} ${document.body.innerText}`);
log(softText.includes("buy the flowers herself"), "tapping the book on the shelf opens it offline");

await browser.close();
stopServer();

if (failures.length) {
  console.log(`\n${failures.length} check(s) failed. Screenshots in ${OUT}/`);
  process.exit(1);
}
console.log(`\nAll offline checks passed. Screenshots in ${OUT}/`);
