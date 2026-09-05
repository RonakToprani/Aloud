import { DrmProtectedError, EpubParseError, parseEpub, parsePlainText, type ParsedBook } from "@/lib/epub/parse";
import { putBook, storageHeadroom, StorageFullError } from "@/lib/storage/db";
import { segmentChapter } from "@/lib/text/segment";
import type { BookMeta } from "@/lib/types";

export { DrmProtectedError, EpubParseError, StorageFullError };

export class FileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTooLargeError";
  }
}

export type ImportStage = "reading" | "parsing" | "indexing" | "saving";

export interface ImportProgress {
  stage: ImportStage;
  fraction: number;
}

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `book-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Counting sentences and words up front means progress and time-remaining are
 *  real numbers rather than estimates from file size. */
async function measure(book: ParsedBook, onProgress?: (fraction: number) => void) {
  const chapterSentenceCounts: number[] = [];
  const chapterWordCounts: number[] = [];

  for (let i = 0; i < book.chapters.length; i++) {
    const segmented = segmentChapter(book.chapters[i]);
    chapterSentenceCounts.push(segmented.sentences.length);
    let words = 0;
    for (const sentence of segmented.sentences) words += sentence.words.length;
    chapterWordCounts.push(words);
    onProgress?.((i + 1) / book.chapters.length);
    if (i % 8 === 7) await yieldToUi();
  }

  return {
    chapterSentenceCounts,
    chapterWordCounts,
    sentenceCount: chapterSentenceCounts.reduce((a, b) => a + b, 0),
    wordCount: chapterWordCounts.reduce((a, b) => a + b, 0),
  };
}

/** Re-adding a book the account already knows about keeps its id, so the
 *  saved place and bookmarks line up with the text again. */
export interface ImportOptions {
  id?: string;
  addedAt?: number;
}

async function persist(
  book: ParsedBook,
  source: BookMeta["source"],
  onProgress?: (progress: ImportProgress) => void,
  options?: ImportOptions,
): Promise<BookMeta> {
  onProgress?.({ stage: "indexing", fraction: 0 });
  const counts = await measure(book, (fraction) =>
    onProgress?.({ stage: "indexing", fraction }),
  );

  const meta: BookMeta = {
    id: options?.id ?? makeId(),
    title: book.title,
    author: book.author,
    source,
    addedAt: options?.addedAt ?? Date.now(),
    chapterTitles: book.chapters.map((chapter) => chapter.title),
    ...counts,
    cover: book.cover,
  };

  onProgress?.({ stage: "saving", fraction: 0 });
  await putBook(meta, { id: meta.id, chapters: book.chapters });
  onProgress?.({ stage: "saving", fraction: 1 });
  return meta;
}

/** EPUBs decompress to several times their file size, and the parsed text plus
 *  the index has to fit alongside. Refuse early rather than half-import. */
async function assertRoom(bytes: number): Promise<void> {
  const headroom = await storageHeadroom();
  if (headroom === null) return;
  const needed = bytes * 4;
  if (headroom > needed) return;
  const mb = (value: number) => `${Math.max(1, Math.round(value / 1024 / 1024))} MB`;
  throw new FileTooLargeError(
    `This book needs about ${mb(needed)} of space and only ${mb(headroom)} is free on this device. Remove a book from your library and try again.`,
  );
}

export async function importFile(
  file: File,
  onProgress?: (progress: ImportProgress) => void,
  options?: ImportOptions,
): Promise<BookMeta> {
  await assertRoom(file.size);
  onProgress?.({ stage: "reading", fraction: 0 });

  const name = file.name.replace(/\.[^.]+$/, "") || "Untitled";
  const isEpub = /\.epub$/i.test(file.name) || file.type === "application/epub+zip";

  if (isEpub) {
    onProgress?.({ stage: "parsing", fraction: 0 });
    const parsed = await parseEpub(file, (fraction) =>
      onProgress?.({ stage: "parsing", fraction }),
    );
    return persist(parsed, "epub", onProgress, options);
  }

  const isText = /\.(txt|md|markdown)$/i.test(file.name) || file.type.startsWith("text/");
  if (!isText) {
    throw new EpubParseError(
      "Aloud reads EPUB and plain text files. This one is neither — if it's a PDF, it'll need converting to EPUB first.",
    );
  }

  onProgress?.({ stage: "parsing", fraction: 0 });
  const text = await file.text();
  return persist(parsePlainText(text, name), "txt", onProgress, options);
}

export async function importPastedText(
  text: string,
  title: string,
  onProgress?: (progress: ImportProgress) => void,
  options?: ImportOptions,
): Promise<BookMeta> {
  return persist(parsePlainText(text, title.trim() || "Pasted text"), "paste", onProgress, options);
}

/** Turns any import failure into something a person can act on. */
export function describeImportError(error: unknown): { title: string; detail: string } {
  if (error instanceof DrmProtectedError) {
    return {
      title: "This book is copy-protected",
      detail:
        "The file is locked with DRM, so its text can only be opened by the shop's own app. A DRM-free EPUB will work.",
    };
  }
  if (error instanceof FileTooLargeError || error instanceof StorageFullError) {
    return { title: "Not enough space on this device", detail: error.message };
  }
  if (error instanceof EpubParseError) {
    return { title: "That file couldn't be opened", detail: error.message };
  }
  if (error instanceof Error && error.name === "StorageUnavailableError") {
    return { title: "Storage isn't available", detail: error.message };
  }
  return {
    title: "That file couldn't be opened",
    detail:
      error instanceof Error && error.message
        ? error.message
        : "Something in the file stopped it being read. Try another copy of the book.",
  };
}
