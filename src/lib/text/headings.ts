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

/** Words that announce a number: what follows "Chapter" or "Part" in a
 *  heading is a numeral, whatever letters it happens to be spelled with. */
const LABEL_WORD =
  /^(?:book|part|chapter|chap|act|scene|canto|volume|vol|section|sect|letter|stave|epistle|bk|pt)$/i;
const ROMAN_LETTERS = /^[IVXLCDM]+$/i;
/** What a heading may put between a label and its numeral: "Chapter: IV". */
const BETWEEN_LABEL_AND_NUMERAL = /^[.:]?$/;
/** After a leading numeral: "I. The Arrival", "IV: Home", "II — The Sea". */
const AFTER_LEADING_NUMERAL = /^[.:\-–—]/;
/** Before a closing numeral: "Part Two — IV", where the label is further back. */
const BEFORE_CLOSING_NUMERAL = /[,\-–—]$/;

interface HeadingToken {
  /** The letters and digits, or empty for a token that is only punctuation. */
  word: string;
  /** Punctuation glued to the word, split off so "IV." is a numeral with a
   *  full stop after it rather than a word the numeral grammar rejects. */
  before: string;
  after: string;
}

/** One token per run of non-whitespace, so the text can be rebuilt from
 *  them over its own spacing. */
function headingTokens(text: string): HeadingToken[] {
  return (text.match(/\S+/g) ?? []).map((raw) => {
    const m = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(raw)!;
    return { before: m[1], word: m[2], after: m[3] };
  });
}

/**
 * Whether the token at `at` sits where a heading puts a number. A roman
 * numeral is only a numeral there; the same letters anywhere else are
 * words, so "Why I Left" keeps its pronoun and "MIX", "CIVIL" and "The XL
 * Files" stay what they say. Numerals are set in one case, so "Mix" is
 * never one either.
 */
function isNumeralPosition(tokens: HeadingToken[], at: number): boolean {
  const token = tokens[at];
  const word = token.word;
  if (!ROMAN_LETTERS.test(word) || romanToInt(word) === null) return false;
  if (word !== word.toUpperCase() && word !== word.toLowerCase()) return false;

  const worded = tokens.filter((t) => t.word);
  // The whole heading: "IV", "XIV.", "I —".
  if (worded.length === 1) return true;

  // Punctuation set off by spaces ("Chapter : IV", "I — Home") belongs to
  // the word beside it.
  const punctuationOnly = (t: HeadingToken | undefined) => t !== undefined && !t.word;
  const previous = punctuationOnly(tokens[at - 1]) ? tokens[at - 2] : tokens[at - 1];
  const betweenPrevious = (punctuationOnly(tokens[at - 1]) ? tokens[at - 1].before : "") + token.before;
  const after = token.after + (punctuationOnly(tokens[at + 1]) ? tokens[at + 1].before : "");

  // Right after a label: "Chapter IV", "Book the IV", "Part: II".
  const labelled = (label: HeadingToken | undefined, between: string) =>
    label !== undefined && LABEL_WORD.test(label.word) && BETWEEN_LABEL_AND_NUMERAL.test(label.after + between);
  if (labelled(previous, betweenPrevious)) return true;
  if (previous && /^the$/i.test(previous.word) && !previous.after && !betweenPrevious) {
    const label = tokens[tokens.indexOf(previous) - 1];
    if (labelled(label, previous.before)) return true;
  }

  // Opening the heading, then a stop or a dash: "I. The Arrival".
  if (worded[0] === token && !token.before && AFTER_LEADING_NUMERAL.test(after)) return true;

  // Closing the heading after a comma or dash, with a label earlier on.
  if (worded[worded.length - 1] === token && previous && BEFORE_CLOSING_NUMERAL.test(previous.after + betweenPrevious)) {
    return tokens.slice(0, at).some((t) => LABEL_WORD.test(t.word));
  }
  return false;
}

/**
 * Converts the roman numerals in a heading to how they are read out loud
 * ("Book II, Chapter IV" -> "Book two, Chapter four"), one token in for one
 * token out so the word offsets that drive the highlight still line up,
 * and only in the positions a heading puts a number (see
 * `isNumeralPosition`): a heading is where "I" and "V" are numbers, but a
 * heading also holds a title, and "I Am Legend" is not chapter one.
 *
 * Only ever called on text already known to be a heading (see
 * `isChapterHeading` / `looksLikeHeading`). Returns null when nothing in the
 * text was a numeral, so a caller can tell "unchanged" from "converted to
 * itself".
 */
export function speakHeadingNumerals(text: string): string | null {
  const tokens = headingTokens(text);
  let changed = false;
  let at = 0;
  const spoken = text.replace(/\S+/g, (raw) => {
    const token = tokens[at];
    const numeral = isNumeralPosition(tokens, at);
    at++;
    if (!numeral) return raw;
    changed = true;
    return token.before + numberToWords(romanToInt(token.word)!) + token.after;
  });
  return changed ? spoken : null;
}
