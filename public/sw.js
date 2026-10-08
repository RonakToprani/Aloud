/* Aloud service worker: keeps the whole app openable offline.

   A page is only useful offline together with the scripts and styles it
   loads, so caching a page means caching the assets it names as well. The
   first version cached the HTML alone and left the chunks to be "cached on
   first use", which never happened for the very first visit (the page had
   already loaded them before this worker took over) and so an installed app
   opened offline was a blank screen. Navigations go network-first and fall
   back to the cached copy of the same page; a page never seen is sent to the
   library rather than served someone else's HTML. API calls are never
   cached. Built assets are immutable and cached on first use; the ones a
   stale page refers to are kept until no cached page refers to them. */
const VERSION = "v2";
const SHELL = `aloud-shell-${VERSION}`;
const ASSETS = `aloud-assets-${VERSION}`;
/** A synthetic entry in the shell cache recording which build the cached
 *  pages came from. */
const BUILD_KEY = "/__aloud/build";

self.addEventListener("install", (event) => {
  event.waitUntil(cachePage("/").catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== SHELL && key !== ASSETS).map((key) => caches.delete(key))),
    ),
  );
  self.clients.claim();
});

/* The page asks for the reader pages of the books on its shelf to be kept,
   because a client-side navigation never produces a navigation fetch here
   and so the reader's own HTML would otherwise never be cached. */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cache-pages" || !Array.isArray(data.urls)) return;
  const work = (async () => {
    for (const url of data.urls) {
      if (typeof url !== "string" || !url.startsWith("/")) continue;
      const cached = await caches.match(pageRequest(url), { cacheName: SHELL });
      if (!cached) await cachePage(url).catch(() => {});
    }
  })();
  if (event.waitUntil) event.waitUntil(work);
});

function pageRequest(url) {
  return new Request(new URL(url, self.location.origin).toString());
}

/** Everything a Next.js page needs to run: the scripts and styles it links,
 *  and the chunks named inside its flight data, which load during hydration
 *  without ever appearing as a tag. */
function assetUrlsIn(html) {
  const urls = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/(?:_next\/static|icons)\/[^"]+)"/g)) {
    urls.add(match[1].replace(/&amp;/g, "&"));
  }
  for (const match of html.matchAll(/\b(static\/(?:chunks|css|media)\/[^"'\s\\<>]+\.(?:js|css|woff2))/g)) {
    urls.add(`/_next/${match[1]}`);
  }
  urls.add("/manifest.webmanifest");
  return [...urls];
}

function buildIdIn(html) {
  const match = html.match(/\/_next\/static\/([^/"]+)\/_buildManifest\.js/);
  return match ? match[1] : null;
}

/** Fetch a page and cache it together with its assets. Resolves to the
 *  response for the caller to hand on, or null if the network said no. */
async function cachePage(url, response) {
  const request = pageRequest(url);
  const fresh = response ?? (await fetch(request));
  if (!fresh.ok || !(fresh.headers.get("content-type") || "").includes("text/html")) return fresh;
  const html = await fresh.clone().text();
  const shell = await caches.open(SHELL);
  await shell.put(request, fresh.clone());
  await cacheAssets(assetUrlsIn(html));
  await noteBuild(buildIdIn(html));
  return fresh;
}

async function cacheAssets(urls) {
  const assets = await caches.open(ASSETS);
  await Promise.all(
    urls.map(async (url) => {
      const request = pageRequest(url);
      if (await assets.match(request)) return;
      try {
        const response = await fetch(request);
        if (response.ok) await assets.put(request, response);
      } catch {
        /* one missing asset is better than no cache at all */
      }
    }),
  );
}

/** A new deploy changes every chunk. The pages cached from the old build
 *  still work offline with the old chunks, so nothing is thrown away
 *  immediately; they are re-fetched in the background, and only assets no
 *  cached page refers to any more are dropped. */
async function noteBuild(buildId) {
  if (!buildId) return;
  const shell = await caches.open(SHELL);
  const noted = await shell.match(BUILD_KEY);
  const previous = noted ? await noted.text() : null;
  if (previous === buildId) return;
  await shell.put(BUILD_KEY, new Response(buildId));
  if (previous) await refreshShell();
}

async function refreshShell() {
  const shell = await caches.open(SHELL);
  const pages = (await shell.keys()).filter((request) => !request.url.endsWith(BUILD_KEY));
  for (const request of pages) {
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        const html = await fresh.clone().text();
        await shell.put(request, fresh);
        await cacheAssets(assetUrlsIn(html));
      }
    } catch {
      /* offline again already; the old copy stays */
    }
  }
  await pruneAssets();
}

async function pruneAssets() {
  const shell = await caches.open(SHELL);
  const wanted = new Set();
  for (const request of await shell.keys()) {
    if (request.url.endsWith(BUILD_KEY)) continue;
    const response = await shell.match(request);
    if (!response) continue;
    for (const url of assetUrlsIn(await response.text())) wanted.add(new URL(url, self.location.origin).toString());
  }
  const assets = await caches.open(ASSETS);
  for (const request of await assets.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/_next/static/") && !wanted.has(request.url)) await assets.delete(request);
  }
}

/* /pdfjs/ and /ort/ carry their version in the path, so a new version never
   overwrites the old one and the old one would otherwise sit in the cache
   for good. Fetching one is the moment we learn which version is current. */
async function dropOldVersions(cache, pathname) {
  const [, root, version] = pathname.split("/");
  if ((root !== "pdfjs" && root !== "ort") || !version) return;
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(`/${root}/`) && path.split("/")[2] !== version) await cache.delete(request);
  }
}

function isImmutableAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/pdfjs/") ||
    pathname.startsWith("/ort/") ||
    pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          // Cached by path alone: the same reader page is asked for with and
          // without a query string, and both must find the one copy.
          event.waitUntil(cachePage(url.pathname, response.clone()).catch(() => {}));
          return response;
        } catch {
          const cached = await caches.match(pageRequest(url.pathname), { cacheName: SHELL });
          if (cached) return cached;
          // A page never visited while online has no HTML of its own, and
          // another page's HTML would hydrate as that other page. The
          // library always has a copy, from install.
          if (url.pathname !== "/") return Response.redirect("/", 302);
          return Response.error();
        }
      })(),
    );
    return;
  }

  if (isImmutableAsset(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ??
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches
                .open(ASSETS)
                .then(async (cache) => {
                  await cache.put(request, copy);
                  await dropOldVersions(cache, url.pathname);
                })
                .catch(() => {});
            }
            return response;
          }),
      ),
    );
  }
});
