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

/** Standard subtractive-notation symbols, longest value first so a greedy
 *  read never has to backtrack. */
const ROMAN_NUMERALS: [string, number][] = [
  ["M", 1000], ["CM", 900], ["D", 500], ["CD", 400],
  ["C", 100], ["XC", 90], ["L", 50], ["XL", 40],
  ["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1],
];

/**
 * A roman numeral, case-insensitively, or null for anything the greedy read
 * doesn't consume completely (a stray initial, "IC", four figures and up).
 * Markup can mislabel a numeral; this is what keeps that honest rather than
 * reading nonsense as a number.
 */
export function romanToInt(raw: string): number | null {
  const text = raw.trim().toUpperCase();
  if (!text) return null;
  let value = 0;
  let i = 0;
  for (const [symbol, amount] of ROMAN_NUMERALS) {
    while (text.startsWith(symbol, i)) {
      value += amount;
      i += symbol.length;
    }
  }
  if (i !== text.length || value < 1 || value > 3999) return null;
  return value;
}

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function threeDigitsToWords(n: number): string {
  const words: string[] = [];
  if (n >= 100) {
    words.push(ONES[Math.floor(n / 100)], "hundred");
    n %= 100;
  }
  if (n >= 20) {
    const tens = TENS[Math.floor(n / 10)];
    const ones = n % 10;
    words.push(ones ? `${tens}-${ONES[ones]}` : tens);
  } else if (n > 0) {
    words.push(ONES[n]);
  }
  return words.join(" ");
}

/** Spells a number out for speech, 0 to 3999; the page keeps its digits. */
export function numberToWords(n: number): string {
  if (n === 0) return "zero";
  const thousands = Math.floor(n / 1000);
  const rest = n % 1000;
  return [thousands ? `${threeDigitsToWords(thousands)} thousand` : "", threeDigitsToWords(rest)]
    .filter(Boolean)
    .join(" ");
}

/** A whole word made only of roman-numeral letters, so a run that merely
 *  contains them ("Vitamin", "Louis") never qualifies — \b anchors the match
 *  to the full word, and a stray English word spelled entirely in I, V, X,
 *  L, C, D, M ("MIX") is left to romanToInt's stricter grammar to reject. */
const ROMAN_WORD = /\b[IVXLCDM]+\b/gi;

/**
 * Converts every roman numeral word in a heading to how it's read out loud
 * ("Book II, Chapter IV" -> "Book two, Chapter four"), one token in for one
 * token out so the word offsets that drive the highlight still line up.
 *
 * Only ever called on text already known to be a heading (see
 * `isChapterHeading` / `looksLikeHeading`). Run against ordinary prose it
 * would turn "Louis XIV" or "a grade of C" into a sentence about numbers —
 * nothing outside a heading block calls this for exactly that reason.
 * Returns null when nothing in the text was a numeral, so a caller can tell
 * "unchanged" from "converted to itself".
 */
export function speakHeadingNumerals(text: string): string | null {
  let changed = false;
  const result = text.replace(ROMAN_WORD, (word) => {
    const value = romanToInt(word);
    if (value === null) return word;
    changed = true;
    return numberToWords(value);
  });
  return changed ? result : null;
}
