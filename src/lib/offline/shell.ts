/**
 * Keeping the reader openable offline.
 *
 * The service worker caches a page when the browser navigates to it, but a
 * tap on the shelf is a client-side navigation and produces no such request:
 * the reader's HTML for that book would never be cached, and the installed
 * app, opened on a plane, would send the reader back to the library. So the
 * shelf and the reader both ask for the pages they know about to be kept.
 * Harmless where there is no service worker, which is every development run.
 */
export function keepPagesOffline(paths: string[]): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !paths.length) return;
  navigator.serviceWorker.ready
    .then((registration) => {
      registration.active?.postMessage({ type: "cache-pages", urls: paths });
    })
    .catch(() => {});
}

export function readerPath(bookId: string): string {
  return `/read/${encodeURIComponent(bookId)}`;
}
