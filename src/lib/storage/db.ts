import type { BookBody, BookMeta, Bookmark } from "@/lib/types";

const DB_NAME = "aloud";
const DB_VERSION = 1;
const BOOKS = "books";
const BODIES = "bodies";
const BOOKMARKS = "bookmarks";

export class StorageFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageFullError";
  }
}

export class StorageUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

/** Delays between attempts to open the database. iOS Safari is known to
 *  fail the first open after a tab is restored and succeed a moment later. */
const OPEN_RETRY_MS = [0, 250, 700, 1500];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function openOnce(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(
        new StorageUnavailableError(
          "This browser has no local storage available, which usually means private browsing. Your library can't be saved here.",
        ),
      );
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS)) db.createObjectStore(BOOKS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BODIES)) db.createObjectStore(BODIES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BOOKMARKS)) {
        const store = db.createObjectStore(BOOKMARKS, { keyPath: "id" });
        store.createIndex("bookId", "bookId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Safari drops the connection when a tab sits in the background and
      // hands back an unusable handle on return. Forget it, so the next
      // call opens a fresh one instead of failing for the rest of the page.
      db.onclose = () => {
        dbPromise = null;
      };
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () =>
      reject(
        new StorageUnavailableError(
          "This browser wouldn't open local storage, so books can't be saved on this device.",
        ),
      );
    request.onblocked = () =>
      reject(
        new StorageUnavailableError(
          "Another tab of Aloud is upgrading storage. Close the other tabs and reload.",
        ),
      );
  });
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const attempt = (async () => {
    let failure: unknown;
    for (const delay of OPEN_RETRY_MS) {
      if (delay) await sleep(delay);
      try {
        return await openOnce();
      } catch (error) {
        failure = error;
        if (typeof indexedDB === "undefined") break;
      }
    }
    throw failure;
  })();
  dbPromise = attempt;
  // A failed open must not poison every later call.
  attempt.catch(() => {
    if (dbPromise === attempt) dbPromise = null;
  });
  return attempt;
}

/** A transaction on a connection Safari has quietly closed throws
 *  synchronously; that is the signal to reconnect and try once more. */
function isStaleConnection(error: unknown): boolean {
  return error instanceof DOMException && error.name === "InvalidStateError";
}

function run<T>(
  storeNames: string | string[],
  mode: IDBTransactionMode,
  body: (tx: IDBTransaction) => IDBRequest<T> | Promise<T>,
  retried = false,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;
        try {
          tx = db.transaction(storeNames, mode);
        } catch (error) {
          if (isStaleConnection(error) && !retried) {
            dbPromise = null;
            resolve(run(storeNames, mode, body, true));
            return;
          }
          reject(error);
          return;
        }
        let result: T;
        let settled = false;

        const outcome = body(tx);
        if (outcome instanceof Promise) {
          outcome.then((value) => {
            result = value;
            settled = true;
          }, reject);
        } else {
          outcome.onsuccess = () => {
            result = outcome.result;
            settled = true;
          };
        }

        tx.oncomplete = () => resolve(settled ? result : (undefined as T));
        tx.onabort = tx.onerror = () => {
          const error = tx.error;
          if (error && (error.name === "QuotaExceededError" || error.name === "NS_ERROR_DOM_QUOTA_REACHED")) {
            reject(
              new StorageFullError(
                "There isn't enough space left on this device to store the book.",
              ),
            );
            return;
          }
          reject(error ?? new Error("The storage request failed."));
        };
      }),
  );
}

export async function listBooks(): Promise<BookMeta[]> {
  const books = await run<BookMeta[]>(BOOKS, "readonly", (tx) =>
    tx.objectStore(BOOKS).getAll() as IDBRequest<BookMeta[]>,
  );
  return books.sort((a, b) => b.addedAt - a.addedAt);
}

export function getBookMeta(id: string): Promise<BookMeta | undefined> {
  return run<BookMeta | undefined>(BOOKS, "readonly", (tx) =>
    tx.objectStore(BOOKS).get(id) as IDBRequest<BookMeta | undefined>,
  );
}

export function getBookBody(id: string): Promise<BookBody | undefined> {
  return run<BookBody | undefined>(BODIES, "readonly", (tx) =>
    tx.objectStore(BODIES).get(id) as IDBRequest<BookBody | undefined>,
  );
}

export function putBook(meta: BookMeta, body: BookBody): Promise<void> {
  return run<void>([BOOKS, BODIES], "readwrite", (tx) => {
    tx.objectStore(BOOKS).put(meta);
    return tx.objectStore(BODIES).put(body) as unknown as IDBRequest<void>;
  });
}

export function deleteBook(id: string): Promise<void> {
  return run<void>([BOOKS, BODIES], "readwrite", (tx) => {
    tx.objectStore(BOOKS).delete(id);
    return tx.objectStore(BODIES).delete(id) as unknown as IDBRequest<void>;
  });
}

export function listBookmarks(bookId: string): Promise<Bookmark[]> {
  return run<Bookmark[]>(BOOKMARKS, "readonly", (tx) => {
    const index = tx.objectStore(BOOKMARKS).index("bookId");
    return index.getAll(IDBKeyRange.only(bookId)) as IDBRequest<Bookmark[]>;
  }).then((marks) =>
    marks.sort(
      (a, b) => a.chapterIndex - b.chapterIndex || a.sentenceIndex - b.sentenceIndex,
    ),
  );
}

export function putBookmark(mark: Bookmark): Promise<void> {
  return run<void>(BOOKMARKS, "readwrite", (tx) =>
    tx.objectStore(BOOKMARKS).put(mark) as unknown as IDBRequest<void>,
  );
}

export function deleteBookmark(id: string): Promise<void> {
  return run<void>(BOOKMARKS, "readwrite", (tx) =>
    tx.objectStore(BOOKMARKS).delete(id) as unknown as IDBRequest<void>,
  );
}

/** Bytes still available, or null when the browser won't say. */
export async function storageHeadroom(): Promise<number | null> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (typeof quota !== "number" || typeof usage !== "number") return null;
    return Math.max(0, quota - usage);
  } catch {
    return null;
  }
}
