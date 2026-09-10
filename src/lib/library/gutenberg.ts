import { assertRoom, importParsedBook, type ImportOptions, type ImportProgress } from "./import";
import { parseEpub } from "@/lib/epub/parse";
import { trimGutenberg } from "@/lib/gutenberg/trim";
import { listBooks } from "@/lib/storage/db";
import type { BookMeta } from "@/lib/types";

/** What it takes to fetch a book: the catalogue entry has it, and so does a
 *  shelved book's metadata on another device. */
export interface GutenbergRef {
  id: number;
  title: string;
  author: string | null;
  hasCover?: boolean;
}

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

/** The copy of this Gutenberg book already on the shelf, if there is one. */
export async function findGutenbergBook(id: number): Promise<BookMeta | undefined> {
  const books = await listBooks();
  return books.find((book) => book.gutenbergId === id);
}

/**
 * Fetches a book from the public library and shelves it like any other
 * EPUB: parsed once, kept as text in IndexedDB on this device, never sent
 * anywhere. The account learns the title, as it does for every book, and
 * nothing else. Asking for a book already on the shelf hands back that copy.
 */
export async function addGutenbergBook(
  book: GutenbergRef,
  onProgress?: (progress: ImportProgress) => void,
  /** For a book the account knows: the same id, so the saved place lines up. */
  options?: Pick<ImportOptions, "id" | "addedAt">,
): Promise<BookMeta> {
  const existing = await findGutenbergBook(book.id);
  if (existing) return existing;

  onProgress?.({ stage: "reading", fraction: 0 });
  const [epub, cover] = await Promise.all([
    download(`/api/gutenberg/epub/${book.id}`, (fraction) =>
      onProgress?.({ stage: "reading", fraction }),
    ),
    book.hasCover === false ? Promise.resolve(undefined) : fetchCover(book.id),
  ]);

  // The same road an uploaded EPUB takes, with one stop on the way: the
  // Gutenberg front matter and licence come off before the book is kept.
  await assertRoom(epub.size, 4);
  onProgress?.({ stage: "parsing", fraction: 0 });
  const parsed = await parseEpub(epub, (fraction) => onProgress?.({ stage: "parsing", fraction }));
  return importParsedBook(trimGutenberg(parsed), "epub", onProgress, {
    ...options,
    title: book.title,
    author: book.author ?? undefined,
    cover,
    gutenbergId: book.id,
  });
}

/** Streams the file so the bar moves with the bytes, not with hope. */
async function download(url: string, onFraction: (fraction: number) => void): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw new DownloadError("The book couldn't be downloaded. Check the connection and try again.");
  }
  if (!response.ok || !response.body) {
    throw new DownloadError(
      response.status === 404
        ? "Project Gutenberg doesn't have this one as an EPUB."
        : "The book couldn't be downloaded. Try again in a moment.",
    );
  }

  const total = Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (total) onFraction(Math.min(1, received / total));
    }
  } catch {
    // The connection went mid-book. That is a download problem, not a file one.
    throw new DownloadError("The download was interrupted. Check the connection and try again.");
  }
  if (total && received < total) {
    throw new DownloadError("The download stopped short. Try again in a moment.");
  }
  onFraction(1);
  return new Blob(chunks as BlobPart[], { type: "application/epub+zip" });
}

/** A missing cover is not a failed book. */
async function fetchCover(id: number): Promise<Blob | undefined> {
  try {
    const response = await fetch(`/api/gutenberg/cover/${id}`);
    if (!response.ok) return undefined;
    const blob = await response.blob();
    return blob.size > 0 ? blob : undefined;
  } catch {
    return undefined;
  }
}
