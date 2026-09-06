import type { BookMeta } from "@/lib/types";

type Counted = Pick<BookMeta, "sentenceCount" | "chapterSentenceCounts">;

/**
 * How far through a book a position is, from 0 to 1.
 *
 * Progress counts sentences finished, so a reader sitting on the third
 * sentence has read two. Reaching the last sentence is the exception: that
 * is the end of the book, and a shelf that says 92% on something you just
 * heard read to the final word looks broken rather than precise.
 */
export function bookFraction(meta: Counted, chapterIndex: number, sentenceIndex: number): number {
  if (!meta.sentenceCount) return 0;
  let before = 0;
  for (let i = 0; i < chapterIndex; i++) before += meta.chapterSentenceCounts[i] ?? 0;
  const done = before + sentenceIndex;
  if (done >= meta.sentenceCount - 1) return 1;
  return Math.min(1, Math.max(0, done / meta.sentenceCount));
}
