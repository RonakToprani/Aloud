"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccountSheet } from "@/components/auth/AccountSheet";
import { useAuth } from "@/components/AuthProvider";
import { StatsHero, StatsStrip } from "@/components/home/Stats";
import { Sheet } from "@/components/ui/Sheet";
import { CloudIcon, PlusIcon, TrashIcon } from "@/components/ui/Icons";
import { Logo } from "@/components/ui/Logo";
import { Toast, type ToastMessage } from "@/components/ui/Toast";
import {
  describeImportError,
  importFile,
  importPastedText,
  type ImportOptions,
  type ImportProgress,
} from "@/lib/library/import";
import { deleteBook, listBooks, putBook, getBookBody } from "@/lib/storage/db";
import { clearPosition, loadPosition, savePosition } from "@/lib/storage/prefs";
import {
  deleteRemoteBook,
  pullBooks,
  pullPositions,
  pushBooks,
  pushPosition,
  type RemoteBook,
} from "@/lib/sync/remote";
import { BookCover } from "./BookCover";
import type { BookBody, BookMeta } from "@/lib/types";
import styles from "./Library.module.css";

/** How long a deleted book can be brought back. */
const UNDO_MS = 6000;
/** Books the account knows about but this device doesn't, kept so the
 *  library paints them before the network answers. */
const REMOTE_CACHE_KEY = "aloud.remoteBooks.v1";

const STAGE_LABEL: Record<ImportProgress["stage"], string> = {
  reading: "Reading the file",
  parsing: "Unpacking the chapters",
  indexing: "Finding the sentences",
  saving: "Saving to this device",
};

interface Reading {
  fraction: number;
  updatedAt: number;
  chapterIndex: number;
  minutesLeft: number;
}

/** A shelf entry: a local book with its text, or one the account remembers. */
interface Entry {
  meta: BookMeta;
  reading: Reading;
  missing: boolean;
}

function readingOf(meta: BookMeta): Reading {
  const position = loadPosition(meta.id);
  if (!position || !meta.sentenceCount) {
    return { fraction: 0, updatedAt: 0, chapterIndex: 0, minutesLeft: meta.wordCount / 165 };
  }
  let before = 0;
  for (let i = 0; i < position.chapterIndex; i++) before += meta.chapterSentenceCounts[i] ?? 0;
  const fraction = Math.min(1, (before + position.sentenceIndex) / meta.sentenceCount);
  return {
    fraction,
    updatedAt: position.updatedAt ?? 0,
    chapterIndex: position.chapterIndex,
    minutesLeft: (meta.wordCount * (1 - fraction)) / 165,
  };
}

function formatLeft(minutes: number): string {
  if (minutes < 1) return "almost done";
  if (minutes < 60) return `${Math.round(minutes)} min left`;
  const hours = minutes / 60;
  return hours < 10 ? `${hours.toFixed(1).replace(/\.0$/, "")} hr left` : `${Math.round(hours)} hr left`;
}

function readRemoteCache(): RemoteBook[] {
  try {
    const raw = localStorage.getItem(REMOTE_CACHE_KEY);
    return raw ? (JSON.parse(raw) as RemoteBook[]) : [];
  } catch {
    return [];
  }
}

function writeRemoteCache(books: RemoteBook[]): void {
  try {
    localStorage.setItem(REMOTE_CACHE_KEY, JSON.stringify(books));
  } catch {
    /* ignore */
  }
}

export function LibraryView() {
  const { status: authStatus, userId, epoch, email } = useAuth();

  const [books, setBooks] = useState<BookMeta[] | null>(null);
  const [remoteBooks, setRemoteBooks] = useState<RemoteBook[]>([]);
  const [positionsVersion, setPositionsVersion] = useState(0);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [dragging, setDragging] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /** The account-only book the reader tapped, waiting for its text. */
  const [missingBook, setMissingBook] = useState<BookMeta | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  /** Set while a file picker is open on behalf of a book that needs its text. */
  const importTarget = useRef<ImportOptions | null>(null);
  const pendingDeletes = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => {
    try {
      const local = await listBooks();
      setBooks(local);
      const localIds = new Set(local.map((book) => book.id));
      setRemoteBooks((current) => current.filter((book) => !localIds.has(book.id)));
    } catch (loadFailure) {
      setStorageError(
        loadFailure instanceof Error
          ? loadFailure.message
          : "Your library couldn't be read from this device.",
      );
      setBooks([]);
    }
  }, []);

  useEffect(() => {
    setRemoteBooks(readRemoteCache());
    void refresh();
  }, [refresh]);

  /* ---------------- sync with the account ---------------- */

  // On every account change: tell the account about books it hasn't seen,
  // learn about books this device hasn't, and agree on where the reader is
  // in each of them. The library never waits on this — it paints from local
  // storage first and adjusts when the answer comes back.
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    (async () => {
      const [remote, positions, local] = await Promise.all([
        pullBooks().catch(() => null),
        pullPositions().catch(() => null),
        listBooks().catch(() => [] as BookMeta[]),
      ]);
      if (!alive || !remote) return;

      const remoteIds = new Set(remote.map((book) => book.id));
      const unknown = local.filter((book) => !remoteIds.has(book.id));
      if (unknown.length) await pushBooks(unknown).catch(() => {});

      if (positions) {
        let changed = false;
        for (const [bookId, position] of positions) {
          const mine = loadPosition(bookId);
          if (!mine || position.updatedAt > mine.updatedAt) {
            savePosition(bookId, position);
            changed = true;
          }
        }
        for (const book of local) {
          const mine = loadPosition(book.id);
          const theirs = positions.get(book.id);
          if (mine && (!theirs || mine.updatedAt > theirs.updatedAt)) {
            void pushPosition(book.id, mine).catch(() => {});
          }
        }
        if (changed) setPositionsVersion((v) => v + 1);
      }

      const localIds = new Set(local.map((book) => book.id));
      const missing = remote.filter((book) => !localIds.has(book.id));
      writeRemoteCache(missing);
      setRemoteBooks(missing);
    })();
    return () => {
      alive = false;
    };
  }, [userId, epoch]);

  // Anything still pending when the page closes is committed for real.
  useEffect(() => {
    const timers = pendingDeletes.current;
    return () => {
      for (const [id, timer] of timers) {
        clearTimeout(timer);
        void deleteBook(id).catch(() => {});
        void deleteRemoteBook(id).catch(() => {});
      }
      timers.clear();
    };
  }, []);

  /* ---------------- importing ---------------- */

  const runImport = useCallback(
    async (task: () => Promise<BookMeta>) => {
      setError(null);
      setMissingBook(null);
      setProgress({ stage: "reading", fraction: 0 });
      try {
        const meta = await task();
        await refresh();
        void pushBooks([meta]).catch(() => {});
      } catch (importFailure) {
        setError(describeImportError(importFailure));
      } finally {
        setProgress(null);
      }
    },
    [refresh],
  );

  const onFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      const options = importTarget.current ?? undefined;
      importTarget.current = null;
      if (!file) return;
      void runImport(() => importFile(file, setProgress, options));
    },
    [runImport],
  );

  const pickFile = useCallback((options?: ImportOptions) => {
    importTarget.current = options ?? null;
    fileInput.current?.click();
  }, []);

  /* ---------------- removing ---------------- */

  const onDelete = useCallback(async (entry: Entry) => {
    const { meta, missing } = entry;

    if (missing) {
      setRemoteBooks((current) => {
        const next = current.filter((book) => book.id !== meta.id);
        writeRemoteCache(next);
        return next;
      });
      clearPosition(meta.id);
      await deleteRemoteBook(meta.id).catch(() => {});
      setToast({ id: Date.now(), text: `Removed ${meta.title} from your account` });
      return;
    }

    let body: BookBody | undefined;
    try {
      body = await getBookBody(meta.id);
    } catch {
      /* restoring won't be possible, but the delete still should be */
    }

    setBooks((current) => (current ?? []).filter((item) => item.id !== meta.id));

    const commit = setTimeout(() => {
      pendingDeletes.current.delete(meta.id);
      void deleteBook(meta.id).catch(() => {});
      void deleteRemoteBook(meta.id).catch(() => {});
      clearPosition(meta.id);
    }, UNDO_MS);
    pendingDeletes.current.set(meta.id, commit);

    setToast({
      id: Date.now(),
      text: `Removed ${meta.title}`,
      durationMs: UNDO_MS - 300,
      action: {
        label: "Undo",
        onAction: () => {
          const timer = pendingDeletes.current.get(meta.id);
          if (timer) clearTimeout(timer);
          pendingDeletes.current.delete(meta.id);
          setBooks((current) => [...(current ?? []), meta].sort((a, b) => b.addedAt - a.addedAt));
          if (body) void putBook(meta, body).catch(() => {});
        },
      },
    });
  }, []);

  /* ---------------- drag & drop ---------------- */

  const onDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      importTarget.current = null;
      onFiles(event.dataTransfer.files);
    },
    [onFiles],
  );

  /* ---------------- derived ---------------- */

  const busy = progress !== null;

  const entries = useMemo<Entry[]>(() => {
    const local = (books ?? []).map((meta) => ({ meta, reading: readingOf(meta), missing: false }));
    const remote = remoteBooks.map((meta) => ({ meta, reading: readingOf(meta), missing: true }));
    return [...local, ...remote].sort((a, b) => b.meta.addedAt - a.meta.addedAt);
    // positionsVersion is a signal that stored positions changed under us.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [books, remoteBooks, positionsVersion]);

  // The most recently opened book that is neither untouched nor finished gets
  // pulled out of the shelf and given the top of the page.
  const continuing = entries
    .filter((e) => e.reading.updatedAt > 0 && e.reading.fraction > 0 && e.reading.fraction <= 0.995)
    .sort((a, b) => b.reading.updatedAt - a.reading.updatedAt)[0];
  const shelf = continuing ? entries.filter((e) => e.meta.id !== continuing.meta.id) : entries;

  const loaded = books !== null;
  const empty = loaded && entries.length === 0;
  const showAccount = authStatus !== "unavailable";
  const signedIn = authStatus === "signed-in";

  const openEntry = (entry: Entry) => {
    if (entry.missing) setMissingBook(entry.meta);
  };

  const accountControl = showAccount ? (
    signedIn ? (
      <button
        type="button"
        className={styles.accountChip}
        onClick={() => setAccountOpen(true)}
        aria-label={`Account, ${email ?? ""}`}
      >
        <span className={styles.accountInitial} aria-hidden="true">
          {(email?.[0] ?? "?").toUpperCase()}
        </span>
      </button>
    ) : (
      <Link href="/signin" className={styles.signInLink}>
        Sign in
      </Link>
    )
  ) : null;

  return (
    <main
      className={styles.page}
      data-landing={empty ? "true" : undefined}
      data-dragging={dragging ? "true" : undefined}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className={styles.head}>
        <h1 className={styles.wordmark}>
          <Logo size={26} />
        </h1>
        <div className={styles.headActions}>
          {!empty && (
            <>
              <button
                type="button"
                className={styles.ghostButton}
                onClick={() => setPasteOpen(true)}
                disabled={busy}
              >
                Paste text
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => pickFile()}
                disabled={busy}
              >
                <PlusIcon size={17} />
                Add a book
              </button>
            </>
          )}
          {accountControl}
        </div>
      </header>

      <input
        ref={fileInput}
        type="file"
        accept=".epub,.txt,.md,application/epub+zip,text/plain"
        className="srOnly"
        onChange={(event) => {
          onFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {busy && progress && (
        <div className={styles.progressCard} role="status" aria-live="polite">
          <div className={styles.progressLabel}>{STAGE_LABEL[progress.stage]}…</div>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ transform: `scaleX(${Math.max(0.04, progress.fraction)})` }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className={styles.errorCard} role="alert">
          <strong>{error.title}</strong>
          <p>{error.detail}</p>
          <button type="button" className={styles.ghostButton} onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}

      {storageError && (
        <div className={styles.errorCard} role="alert">
          <strong>Your library can&rsquo;t be saved here</strong>
          <p>{storageError}</p>
        </div>
      )}

      {!loaded ? (
        <div className={styles.placeholder} aria-hidden="true" />
      ) : empty ? (
        <>
          {/* First visit: say what this is, show what it has done, and let
              the reader start without an account. */}
          <section className={styles.landing}>
            <StatsHero />
            <div className={styles.landingRule} aria-hidden="true" />
            <p className={styles.landingSentence}>
              Bring your own books. Press play, and{" "}
              <span className={styles.landingPill}>every</span> word lights as it&rsquo;s spoken.
            </p>
          </section>
          <div className={styles.landingActions}>
            <button
              type="button"
              className={styles.landingPrimary}
              onClick={() => pickFile()}
              disabled={busy}
            >
              Add a book
            </button>
            <button
              type="button"
              className={styles.landingSecondary}
              onClick={() => setPasteOpen(true)}
              disabled={busy}
            >
              Paste text
            </button>
            <p className={styles.landingCaption}>
              {showAccount
                ? signedIn
                  ? "Books you add here appear in your library on every device you sign in to."
                  : "Read without an account. Sign in to keep your place across devices."
                : "Everything stays on this device. Drop a file anywhere on this page."}
            </p>
          </div>
        </>
      ) : (
        <>
          <StatsStrip />

          {continuing && (
            <section className={styles.continue} aria-labelledby="continue-heading">
              <h2 id="continue-heading" className={styles.sectionLabel}>
                Continue reading
              </h2>
              {continuing.missing ? (
                <button
                  type="button"
                  className={styles.continueCard}
                  data-missing="true"
                  onClick={() => openEntry(continuing)}
                >
                  <ContinueBody entry={continuing} />
                </button>
              ) : (
                <Link href={`/read/${continuing.meta.id}`} className={styles.continueCard}>
                  <ContinueBody entry={continuing} />
                </Link>
              )}
            </section>
          )}

          {shelf.length > 0 && (
            <section aria-labelledby="shelf-heading">
              <h2 id="shelf-heading" className={styles.sectionLabel}>
                {continuing ? "Everything else" : "Your books"}
              </h2>
              <ul className={styles.shelf}>
                {shelf.map((entry) => {
                  const { meta, reading, missing } = entry;
                  const body = (
                    <>
                      <span className={styles.tileCoverWrap}>
                        <BookCover meta={meta} />
                        {missing && (
                          <span className={styles.tileBadge} aria-hidden="true">
                            <CloudIcon size={15} />
                          </span>
                        )}
                      </span>
                      <span className={styles.tileTitle}>{meta.title}</span>
                      <span className={styles.tileMeta}>
                        {missing
                          ? "Not on this device"
                          : reading.fraction > 0.995
                            ? "Finished"
                            : reading.fraction > 0
                              ? `${Math.round(reading.fraction * 100)}%`
                              : formatLeft(reading.minutesLeft)}
                      </span>
                      {reading.fraction > 0 && reading.fraction <= 0.995 && (
                        <span className={styles.tileBar}>
                          <span
                            className={styles.tileBarFill}
                            style={{ transform: `scaleX(${reading.fraction})` }}
                          />
                        </span>
                      )}
                    </>
                  );
                  return (
                    <li key={meta.id} className={styles.tile} data-missing={missing ? "true" : undefined}>
                      {missing ? (
                        <button type="button" className={styles.tileLink} onClick={() => openEntry(entry)}>
                          {body}
                        </button>
                      ) : (
                        <Link href={`/read/${meta.id}`} className={styles.tileLink}>
                          {body}
                        </Link>
                      )}
                      <button
                        type="button"
                        className={styles.remove}
                        onClick={() => void onDelete(entry)}
                        aria-label={`Remove ${meta.title}`}
                      >
                        <TrashIcon size={15} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}

      <Sheet open={pasteOpen} title="Paste text" onClose={() => setPasteOpen(false)}>
        <label className={styles.pasteField}>
          <span className={styles.pasteLabel}>Title</span>
          <input
            className={styles.pasteInput}
            value={pasteTitle}
            onChange={(event) => setPasteTitle(event.target.value)}
            placeholder="An article, a chapter, a letter"
          />
        </label>
        <label className={styles.pasteField}>
          <span className={styles.pasteLabel}>Text</span>
          <textarea
            className={styles.pasteArea}
            value={pasteBody}
            onChange={(event) => setPasteBody(event.target.value)}
            rows={9}
            placeholder="Paste anything you'd like read aloud. Blank lines separate paragraphs."
          />
        </label>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!pasteBody.trim()}
          onClick={() => {
            const title = pasteTitle;
            const body = pasteBody;
            const options = importTarget.current ?? undefined;
            importTarget.current = null;
            setPasteOpen(false);
            setPasteTitle("");
            setPasteBody("");
            void runImport(() => importPastedText(body, title, setProgress, options));
          }}
        >
          Add to library
        </button>
      </Sheet>

      {/* A book the account remembers but this device has never held. Its
          text was never uploaded — that is the promise on the sign-in
          screen — so the reader supplies it again and the saved place fits
          straight onto it. */}
      <Sheet open={missingBook !== null} title="Not on this device" onClose={() => setMissingBook(null)}>
        {missingBook && (
          <>
            <div className={styles.missingWho}>
              <span className={styles.missingTitle}>{missingBook.title}</span>
              {missingBook.author && <span className={styles.missingAuthor}>{missingBook.author}</span>}
            </div>
            <p className={styles.missingBody}>
              Your place and bookmarks are saved to your account, but the text stays on the device
              you added it from. Add the same {missingBook.source === "paste" ? "text" : "file"}{" "}
              here and you&rsquo;ll carry on
              {readingOf(missingBook).fraction > 0
                ? ` in ${missingBook.chapterTitles[readingOf(missingBook).chapterIndex] ?? "the same chapter"}`
                : " from the start"}
              .
            </p>
            {missingBook.source === "paste" ? (
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => {
                  importTarget.current = { id: missingBook.id, addedAt: missingBook.addedAt };
                  setPasteTitle(missingBook.title);
                  setMissingBook(null);
                  setPasteOpen(true);
                }}
              >
                Paste the text again
              </button>
            ) : (
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => pickFile({ id: missingBook.id, addedAt: missingBook.addedAt })}
              >
                <PlusIcon size={17} />
                Choose the {missingBook.source === "epub" ? "EPUB" : "file"}
              </button>
            )}
            <button
              type="button"
              className={styles.ghostButton}
              onClick={() => {
                const target = entries.find((entry) => entry.meta.id === missingBook.id);
                setMissingBook(null);
                if (target) void onDelete(target);
              }}
            >
              Remove from my library
            </button>
          </>
        )}
      </Sheet>

      <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} />

      {dragging && (
        <div className={styles.dropVeil} aria-hidden="true">
          <span>Drop the book here</span>
        </div>
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </main>
  );
}

function ContinueBody({ entry }: { entry: Entry }) {
  const { meta, reading, missing } = entry;
  return (
    <>
      <BookCover meta={meta} size="lg" className={styles.continueCover} />
      <span className={styles.continueBody}>
        <span className={styles.continueTitle}>{meta.title}</span>
        {meta.author && <span className={styles.continueAuthor}>{meta.author}</span>}
        <span className={styles.continueWhere}>
          {meta.chapterTitles.length > 1
            ? meta.chapterTitles[reading.chapterIndex]
            : formatLeft(reading.minutesLeft)}
        </span>
        <span className={styles.continueBar}>
          <span className={styles.continueBarFill} style={{ transform: `scaleX(${reading.fraction})` }} />
        </span>
        <span className={styles.continueFoot}>
          <span className={styles.resume}>{missing ? "Add the text" : "Resume"}</span>
          <span className={styles.continueLeft}>
            {missing ? "Not on this device" : formatLeft(reading.minutesLeft)}
          </span>
        </span>
      </span>
    </>
  );
}
