/** Shared domain types for the reader. */

export type BlockKind = "h1" | "h2" | "h3" | "p" | "quote" | "image";

export interface Block {
  kind: BlockKind;
  /** For every kind but "image" this is what's read aloud. An image block
   *  carries no text of its own — its caption, below, is what may be spoken. */
  text: string;
  /** What should be spoken, when it must differ from what's shown (a roman
   *  numeral marked up as one, read as a word rather than spelled out).
   *  Absent when speech should just use `text`. */
  speakable?: string;
  /** image blocks only: path into the zip, resolved at parse time, used to
   *  look the bytes up in the body's `images` map. */
  src?: string;
  alt?: string;
  /** A figure's <figcaption>, read like an ordinary paragraph even though the
   *  image itself is never spoken. */
  caption?: string;
}

export interface Chapter {
  id: string;
  /** Human title for the chapter nav. */
  title: string;
  blocks: Block[];
}

/** Everything about a book except its parsed body, so the library can list
 *  quickly without pulling megabytes of chapter text out of IndexedDB. */
export interface BookMeta {
  id: string;
  title: string;
  author: string | null;
  /** Source of the text, for the library subtitle. */
  source: "epub" | "pdf" | "txt" | "paste";
  addedAt: number;
  /** Total sentences across the whole book — the denominator for progress. */
  sentenceCount: number;
  chapterTitles: string[];
  /** Sentence count per chapter, so a position maps to a book-wide fraction. */
  chapterSentenceCounts: number[];
  /** Word count per chapter, for the time-remaining estimate. */
  chapterWordCounts: number[];
  wordCount: number;
  cover?: Blob;
  /** Set on a book fetched from Project Gutenberg, so browsing can tell
   *  what is already on the shelf and adding twice opens the same copy.
   *  Stays on the device: the sync layer maps book columns by name. */
  gutenbergId?: number;
}

export interface BookBody {
  id: string;
  chapters: Chapter[];
  /** Illustration bytes, keyed by the zip path an image block's `src` names.
   *  Absent for a book with none, or once every image has been dropped for
   *  going over the per-book cap (see IMAGE_BUDGET_BYTES in epub/parse.ts).
   *  Never synced: the account layer only ever sees BookMeta. */
  images?: Record<string, Blob>;
}

export interface Book extends BookMeta {
  chapters: Chapter[];
}

/** Where the reader is, precise to the word. */
export interface Position {
  chapterIndex: number;
  sentenceIndex: number;
  /** Word within the sentence. Restored playback starts here. */
  wordIndex: number;
  updatedAt: number;
}

export interface Bookmark {
  id: string;
  bookId: string;
  chapterIndex: number;
  sentenceIndex: number;
  /** Snapshot of the sentence text so the list reads well without a book load. */
  preview: string;
  chapterTitle: string;
  createdAt: number;
}
