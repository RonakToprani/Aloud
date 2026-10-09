/**
 * Where rendered sentences live between sessions.
 *
 * On a phone the model runs slower than speech, so a sentence is never
 * synthesised at the moment it is needed if that can be helped: it is
 * rendered ahead and kept, and playback reads from here. Kept in its own
 * database rather than alongside the books, so a mistake with audio can
 * never touch the text, and in 16-bit mono at 24 kHz, 48 KB a second.
 *
 * The budget is what keeps a long book from filling the device: when the
 * store passes it, the clips heard longest ago go first. A clip read back is
 * marked as recently used, but only now and then, so a chapter being read
 * does not cost a write per sentence.
 */

import type { AlignedWord } from "./align";

const DB_NAME = "aloud-audio";
const DB_VERSION = 1;
const CLIPS = "clips";

/** How much rendered audio to keep: about an hour and three quarters. */
export const CLIP_BUDGET_BYTES = 300 * 1024 * 1024;
/** A hit younger than this is not re-stamped. */
const TOUCH_INTERVAL_MS = 10 * 60 * 1000;

export interface StoredClip {
  key: string;
  pcm: ArrayBuffer;
  durationMs: number;
  words: AlignedWord[];
  bytes: number;
  /** Last read or written. */
  at: number;
}

export class ClipStore {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase | null> | null = null;
  private totalBytes: number | null = null;

  private open(): Promise<IDBDatabase | null> {
    if (this.db) return Promise.resolve(this.db);
    if (this.opening) return this.opening;
    this.opening = new Promise<IDBDatabase | null>((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch {
        return resolve(null);
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CLIPS)) {
          const store = db.createObjectStore(CLIPS, { keyPath: "key" });
          store.createIndex("at", "at");
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading, or storage being cleared: drop the handle so
        // the next call reopens rather than failing forever.
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        this.db = db;
        resolve(db);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    }).finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    return this.open().then(
      (db) =>
        new Promise<T | undefined>((resolve) => {
          if (!db) return resolve(undefined);
          try {
            const tx = db.transaction(CLIPS, mode);
            const req = run(tx.objectStore(CLIPS));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(undefined);
            tx.onabort = () => resolve(undefined);
          } catch {
            resolve(undefined);
          }
        }),
    );
  }

  async get(key: string): Promise<StoredClip | null> {
    const clip = await this.request<StoredClip>("readonly", (store) => store.get(key));
    if (!clip) return null;
    if (Date.now() - clip.at > TOUCH_INTERVAL_MS) {
      void this.request("readwrite", (store) => store.put({ ...clip, at: Date.now() }));
    }
    return clip;
  }

  /** Which of these keys are present, without reading the audio. */
  async has(keys: string[]): Promise<Set<string>> {
    const present = new Set<string>();
    const db = await this.open();
    if (!db || !keys.length) return present;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(CLIPS, "readonly");
        const store = tx.objectStore(CLIPS);
        for (const key of keys) {
          const req = store.getKey(key);
          req.onsuccess = () => {
            if (req.result !== undefined) present.add(key);
          };
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
    return present;
  }

  async put(clip: StoredClip): Promise<void> {
    await this.request("readwrite", (store) => store.put(clip));
    if (this.totalBytes === null) this.totalBytes = await this.measure();
    else this.totalBytes += clip.bytes;
    if (this.totalBytes > CLIP_BUDGET_BYTES) await this.evict(this.totalBytes - CLIP_BUDGET_BYTES);
  }

  /** Total bytes held, by walking the store once. */
  private async measure(): Promise<number> {
    const db = await this.open();
    if (!db) return 0;
    return new Promise<number>((resolve) => {
      let total = 0;
      try {
        const tx = db.transaction(CLIPS, "readonly");
        const cursor = tx.objectStore(CLIPS).openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current) return resolve(total);
          total += (current.value as StoredClip).bytes ?? 0;
          current.continue();
        };
        cursor.onerror = () => resolve(total);
      } catch {
        resolve(total);
      }
    });
  }

  /** Remove the least recently used clips until `bytes` have gone. */
  private async evict(bytes: number): Promise<void> {
    const db = await this.open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      let freed = 0;
      try {
        const tx = db.transaction(CLIPS, "readwrite");
        const cursor = tx.objectStore(CLIPS).index("at").openCursor();
        cursor.onsuccess = () => {
          const current = cursor.result;
          if (!current || freed >= bytes) return resolve();
          freed += (current.value as StoredClip).bytes ?? 0;
          current.delete();
          current.continue();
        };
        cursor.onerror = () => resolve();
        tx.oncomplete = () => {
          if (this.totalBytes !== null) this.totalBytes = Math.max(0, this.totalBytes - freed);
          resolve();
        };
      } catch {
        resolve();
      }
    });
  }
}
