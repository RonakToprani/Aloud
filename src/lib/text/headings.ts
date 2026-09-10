/**
 * Heuristics for spotting a chapter opening in text that carries no markup
 * saying so. Shared by the EPUB parser, where a converted book's chapter
 * openings are ordinary paragraphs, and the PDF parser, where there is no
 * markup at all.
 */

/** Invisible characters that would otherwise land inside words. */
export const INVISIBLE = /[\u00AD\u200B\u200C\u200D\uFEFF]/g;

export function clean(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

export const CHAPTER_WORD =
  /^(chapter|part|book|prologue|epilogue|interlude|intermission|act|scene|canto|letter|section)\b/i;
export const ROMAN = /^[IVXLCDM]{1,8}$/;

/** Trailing punctuation a heading may carry: "Chapter One." or "I —". */
export function bareHeading(text: string): string {
  return text.replace(/[.:\-–—]+$/, "").trim();
}

/** Titles a chapter should be split at even without a table of contents. */
export function isChapterHeading(text: string): boolean {
  const bare = bareHeading(text);
  return CHAPTER_WORD.test(bare) || ROMAN.test(bare) || /^\d{1,3}$/.test(bare);
}

/** A line set in capitals, which in a book is nearly always a heading. */
export function isAllCaps(text: string): boolean {
  const letters = text.replace(/[^\p{L}]/gu, "");
  if (letters.length < 3) return false;
  return letters === letters.toUpperCase() && letters !== letters.toLowerCase();
}
