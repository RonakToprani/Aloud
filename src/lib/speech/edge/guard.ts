/**
 * The synthesis route is for this app's own reader, not a general service.
 * These checks keep a public deployment from becoming an open relay while
 * being invisible to anyone actually reading a book.
 */

/**
 * The browser extension is the one other caller. Its requests come from its
 * service worker with an `Origin` of `chrome-extension://<id>`, and the id is
 * fixed per build: one for the Web Store listing, one per unpacked path. The
 * allowed ids are an environment variable rather than code so a new build
 * can be admitted, or a leaked one shut out, without a deploy.
 */
export function allowedExtensionIds(env: string | undefined = process.env.ALOUD_EXTENSION_IDS): Set<string> {
  return new Set(
    (env ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => /^[a-p]{32}$/.test(id)),
  );
}

/** Requests must come from a page served by this same deployment, or from
 *  an admitted build of the extension. */
export function isSameOrigin(request: Request, extensionIds: Set<string> = allowedExtensionIds()): boolean {
  const host = request.headers.get("host");
  if (!host) return false;

  const stated = request.headers.get("origin") ?? request.headers.get("referer");
  if (!stated) {
    // Same-origin fetch() always sends Origin; a request without one is not
    // coming from the reader.
    return false;
  }
  try {
    const url = new URL(stated);
    if (url.protocol === "chrome-extension:") return extensionIds.has(url.host.toLowerCase());
    return url.host === host;
  } catch {
    return false;
  }
}

interface Window {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 60_000;
/** A reader speaks roughly one sentence every few seconds, and prefetches one
 *  ahead, so this is many times normal use. */
const MAX_PER_WINDOW = 120;

const windows = new Map<string, Window>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

/**
 * Best-effort per-client throttle. Serverless instances do not share memory, so
 * this caps abuse from one instance rather than enforcing a global quota — it
 * is a speed bump, not a gate.
 */
export function withinRateLimit(request: Request): boolean {
  const key = clientKey(request);
  const now = Date.now();
  const existing = windows.get(key);

  if (!existing || now > existing.resetAt) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (windows.size > 500) {
      for (const [k, v] of windows) if (now > v.resetAt) windows.delete(k);
    }
    return true;
  }
  existing.count += 1;
  return existing.count <= MAX_PER_WINDOW;
}
