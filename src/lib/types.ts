/** Shared domain types for the reader. */

export type BlockKind = "h1" | "h2" | "h3" | "p" | "quote";

export interface Block {
  kind: BlockKind;
  text: string;
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
  source: "epub" | "txt" | "paste";
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
}

export interface BookBody {
  id: string;
  chapters: Chapter[];
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
