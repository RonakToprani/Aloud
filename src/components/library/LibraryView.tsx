"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { PlusIcon, TrashIcon } from "@/components/ui/Icons";
import { Logo } from "@/components/ui/Logo";
import { Toast, type ToastMessage } from "@/components/ui/Toast";
import {
  describeImportError,
  importFile,
  importPastedText,
  type ImportProgress,
} from "@/lib/library/import";
import { deleteBook, listBooks, putBook, getBookBody } from "@/lib/storage/db";
import { clearPosition, loadPosition } from "@/lib/storage/prefs";
import type { BookBody, BookMeta } from "@/lib/types";
import styles from "./Library.module.css";

/** How long a deleted book can be brought back. */
const UNDO_MS = 6000;

const STAGE_LABEL: Record<ImportProgress["stage"], string> = {
  reading: "Reading the file",
  parsing: "Unpacking the chapters",
  indexing: "Finding the sentences",
  saving: "Saving to this device",
};

function progressOf(meta: BookMeta): number {
  const position = loadPosition(meta.id);
  if (!position || !meta.sentenceCount) return 0;
  let before = 0;
  for (let i = 0; i < position.chapterIndex; i++) before += meta.chapterSentenceCounts[i] ?? 0;
  return Math.min(1, (before + position.sentenceIndex) / meta.sentenceCount);
}

function readingTime(meta: BookMeta): string {
  const minutes = meta.wordCount / 165;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} min`;
  return `${Math.round(minutes / 60)} hr`;
}

export function LibraryView() {
  const [books, setBooks] = useState<BookMeta[] | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<{ title: string; detail: string } | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteBody, setPasteBody] = useState("");
  const [dragging, setDragging] = useState(false);

  const fileInput = useRef<HTMLInputElement>(null);
  const pendingDeletes = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => {
    try {
      setBooks(await listBooks());
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
    void refresh();
  }, [refresh]);

  // Anything still pending when the page closes is committed for real.
  useEffect(() => {
    const timers = pendingDeletes.current;
    return () => {
      for (const [id, timer] of timers) {
        clearTimeout(timer);
        void deleteBook(id).catch(() => {});
      }
      timers.clear();
    };
  }, []);

  const runImport = useCallback(
    async (task: () => Promise<BookMeta>) => {
      setError(null);
      setProgress({ stage: "reading", fraction: 0 });
      try {
        await task();
        await refresh();
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
      if (!file) return;
      void runImport(() => importFile(file, setProgress));
    },
    [runImport],
  );

  const onDelete = useCallback(
    async (meta: BookMeta) => {
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
            setBooks((current) =>
              [...(current ?? []), meta].sort((a, b) => b.addedAt - a.addedAt),
            );
            if (body) void putBook(meta, body).catch(() => {});
          },
        },
      });
    },
    [],
  );

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
      onFiles(event.dataTransfer.files);
    },
    [onFiles],
  );

  const busy = progress !== null;

  return (
    <main
      className={styles.page}
      data-dragging={dragging ? "true" : undefined}
      onDragEnter={onDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <header className={styles.head}>
        <h1 className={styles.wordmark}>
          <Logo size={28} />
        </h1>
        <div className={styles.headActions}>
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
            onClick={() => fileInput.current?.click()}
            disabled={busy}
          >
            <PlusIcon size={17} />
            Add a book
          </button>
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

      {books === null ? (
        <div className={styles.placeholder} aria-hidden="true" />
      ) : books.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing on the shelf yet</p>
          <p className={styles.emptyBody}>
            Add an EPUB and Aloud will read it to you, lighting up each word as it goes. Plain text
            files work too, and you can paste anything you like.
          </p>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => fileInput.current?.click()}
          >
            <PlusIcon size={17} />
            Add a book
          </button>
          <p className={styles.emptyHint}>Or drop a file anywhere on this page.</p>
        </div>
      ) : (
        <ul className={styles.shelf}>
          {books.map((meta) => {
            const fraction = progressOf(meta);
            return (
              <li key={meta.id} className={styles.item}>
                <Link href={`/read/${meta.id}`} className={styles.itemLink}>
                  <span className={styles.itemTitle}>{meta.title}</span>
                  <span className={styles.itemMeta}>
                    {meta.author && <span className={styles.itemAuthor}>{meta.author}</span>}
                    <span>
                      {meta.chapterTitles.length === 1
                        ? readingTime(meta)
                        : `${meta.chapterTitles.length} chapters · ${readingTime(meta)}`}
                    </span>
                  </span>
                  <span className={styles.itemProgress}>
                    <span
                      className={styles.itemProgressFill}
                      style={{ transform: `scaleX(${fraction})` }}
                    />
                  </span>
                  <span className={styles.itemProgressLabel}>
                    {fraction > 0.995
                      ? "Finished"
                      : fraction > 0
                        ? `${Math.round(fraction * 100)}% read`
                        : "Not started"}
                  </span>
                </Link>
                <button
                  type="button"
                  className={styles.remove}
                  onClick={() => void onDelete(meta)}
                  aria-label={`Remove ${meta.title}`}
                >
                  <TrashIcon />
                </button>
              </li>
            );
          })}
        </ul>
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
            setPasteOpen(false);
            setPasteTitle("");
            setPasteBody("");
            void runImport(() => importPastedText(body, title, setProgress));
          }}
        >
          Add to library
        </button>
      </Sheet>

      {dragging && (
        <div className={styles.dropVeil} aria-hidden="true">
          <span>Drop the book here</span>
        </div>
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </main>
  );
}
