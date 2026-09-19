import type { Block, Chapter } from "@/lib/types";

/** A word-like run inside a sentence, offsets relative to the sentence text. */
export interface WordToken {
  start: number;
  end: number;
}

export interface Sentence {
  /** Chapter-wide index. */
  index: number;
  /** Which block of the chapter this sentence lives in. */
  blockIndex: number;
  /** Exact slice of the block, trailing whitespace included, so that
   *  concatenating a block's sentences reproduces the block verbatim. */
  text: string;
  /** What we hand to the speech engine — same string, trimmed. */
  speakable: string;
  /** Offset of `speakable` within `text`, so word offsets can be rendered. */
  lead: number;
  /** Offsets into `text` (by way of `lead`), for measuring and for tapping
   *  a word on the page. */
  words: WordToken[];
  /** The same tokenizer applied to `speakable` instead, offsets into it. A
   *  roman numeral read as a word ("I" -> "one") is one token either way,
   *  so word i here is word i in `words` — that's what lets the
   *  synchronizer light the displayed word from a boundary reported against
   *  the spoken one. Equal in length to `words` unless something about the
   *  override changes the token count, in which case both are emptied
   *  rather than offer an index that doesn't line up. */
  speakableWords: WordToken[];
}

export interface SegmentedChapter {
  blocks: Block[];
  sentences: Sentence[];
  /** sentence indices per block, in reading order. */
  blockSentences: number[][];
}

type SegmenterCtor = typeof Intl.Segmenter;

function segmenter(granularity: "sentence" | "word"): Intl.Segmenter | null {
  const Ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (!Ctor) return null;
  try {
    return new Ctor(undefined, { granularity });
  } catch {
    return null;
  }
}

/** Abbreviations that must not end a sentence in the regex fallback. */
const ABBREV =
  /(?:^|\s)(?:mr|mrs|ms|dr|prof|st|sr|jr|vs|etc|e\.g|i\.e|fig|no|vol|ch|pp|approx|dept|est)\.$/i;

function splitSentencesFallback(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "…") continue;
    // Absorb runs of terminators plus any closing quote/bracket.
    let j = i;
    while (j + 1 < text.length && /[.!?…]/.test(text[j + 1])) j++;
    while (j + 1 < text.length && /["'’”»)\]]/.test(text[j + 1])) j++;
    const next = text[j + 1];
    // A sentence only ends when whitespace or the end of the block follows.
    if (next !== undefined && !/\s/.test(next)) {
      i = j;
      continue;
    }
    const candidate = text.slice(start, j + 1);
    if (ABBREV.test(candidate)) {
      i = j;
      continue;
    }
    // Keep the whitespace that follows attached to this sentence.
    let k = j + 1;
    while (k < text.length && /\s/.test(text[k])) k++;
    out.push(text.slice(start, k));
    start = k;
    i = k - 1;
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** Titles and initials that end in a period without ending a sentence. */
const ABBREV_TAIL =
  /(?:^|[\s(\["'‘“])(?:mr|mrs|ms|mx|dr|prof|rev|hon|st|sr|jr|vs|etc|al|e\.g|i\.e|cf|fig|no|vol|ch|pp|approx|dept|est|inc|ltd|co|capt|col|gen|lt|sgt|maj|messrs|mt|ft|ave|blvd|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/i;
/** A lone initial, as in "J. R. R. Tolkien". Also true right after an opening
 *  bracket or quote ("[D. Anderson]"), where there is no preceding space for
 *  the plain \s case to key off. */
const INITIAL_TAIL = /(?:^|[\s(\["'‘“])[A-Z]\.$/;

/**
 * Intl.Segmenter breaks after "Mrs." because browsers ship ICU without its
 * abbreviation suppression list. Stitching those breaks back together is what
 * keeps "Mrs. Dalloway said she would buy the flowers herself." one utterance
 * rather than two.
 */
function mergeFalseBreaks(parts: string[]): string[] {
  const out: string[] = [];
  let run = 0;

  for (const part of parts) {
    const previous = out[out.length - 1];
    if (previous !== undefined && run < 8 && shouldMerge(previous, part)) {
      out[out.length - 1] = previous + part;
      run += 1;
      continue;
    }
    out.push(part);
    run = 0;
  }
  return out;
}

function shouldMerge(previous: string, next: string): boolean {
  const left = previous.trimEnd();
  const right = next.trimStart();
  if (!left || !right) return false;

  if (ABBREV_TAIL.test(left) || INITIAL_TAIL.test(left)) return true;
  // A decimal or a numbered list item split across the point.
  if (/\d\.$/.test(left) && /^\d/.test(right)) return true;
  // Real sentences don't begin in lower case or with a clause separator.
  if (/^[\p{Ll},;:)]/u.test(right)) return true;
  return false;
}

/** A bracketed run, opening bracket to the matching close, nothing nested. */
const BRACKETED_RUN = /[[(][^[\]()]*[\])]/y;
/** A run that ends the way a sentence does, "(He had asked twice.)": a
 *  sentence in brackets is still a sentence. */
const SENTENCE_IN_BRACKETS = /[.!?…]["'’”»]*[\])]$/;
/** What may open the sentence after a note: a capital, a quote, another note. */
const RESUMES_SENTENCE = /^[\p{Lu}"'‘“(\[]/u;

/**
 * A bracketed note that a sentence break landed in front of - an
 * attribution after a quote, `great service." [Scott D. Anderson]`, or an
 * aside, "(per the editor)" - belongs to the sentence it follows: a reader
 * says it in the same breath, and a break there put a full sentence pause
 * at the opening bracket. The note is moved back onto the sentence before
 * it, and the break moves to after the closing bracket, so what follows
 * ("The next sentence...") still opens a sentence of its own. A run the
 * segmenter split inside ("[Scott D. " then "Anderson] ...", off the
 * initial) is taken whole. A full sentence in brackets, ending in its own
 * stop, keeps the break it was given, and a paragraph that opens with a
 * bracket has nothing to fold into and is left alone.
 */
function attachBracketedNotes(text: string, parts: string[]): string[] {
  const queue = [...parts];
  const out: string[] = [];
  let offset = 0;
  for (let i = 0; i < queue.length; i++) {
    const part = queue[i];
    const partStart = offset;
    let partEnd = offset + part.length;
    const lead = part.length - part.trimStart().length;
    const open = partStart + lead;
    let run: RegExpExecArray | null = null;
    if (out.length && lead < part.length && /[[(]/.test(text[open])) {
      BRACKETED_RUN.lastIndex = open;
      run = BRACKETED_RUN.exec(text);
    }
    if (!run || SENTENCE_IN_BRACKETS.test(run[0])) {
      out.push(part);
      offset = partEnd;
      continue;
    }
    let cut = open + run[0].length;
    while (cut < text.length && /\s/.test(text[cut])) cut++;
    while (partEnd < cut && i + 1 < queue.length) partEnd += queue[++i].length;
    // Whatever follows the note is only a sentence if it starts like one;
    // "[1] the next thing" runs on into the same sentence.
    if (!RESUMES_SENTENCE.test(text.slice(cut, partEnd))) cut = partEnd;
    out[out.length - 1] += text.slice(partStart, cut);
    if (cut < partEnd) queue.splice(i + 1, 0, text.slice(cut, partEnd));
    offset = cut;
  }
  return out;
}

function splitSentences(text: string): string[] {
  const seg = segmenter("sentence");
  let parts: string[] = [];
  if (seg) for (const s of seg.segment(text)) parts.push(s.segment);
  if (!parts.length) parts = splitSentencesFallback(text);
  return mergeFalseBreaks(attachBracketedNotes(text, parts));
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’‐‑-]*/gu;

/** Word-like runs, offsets relative to `text`. */
export function tokenizeWords(text: string): WordToken[] {
  const seg = segmenter("word");
  const out: WordToken[] = [];
  if (seg) {
    for (const s of seg.segment(text)) {
      if (!s.isWordLike) continue;
      out.push({ start: s.index, end: s.index + s.segment.length });
    }
    // Intl splits "don't" into three word-like pieces in some locales; glue
    // runs joined by an apostrophe or hyphen back into one spoken word.
    return glue(text, out);
  }
  WORD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_RE.exec(text))) out.push({ start: m.index, end: m.index + m[0].length });
  return out;
}

function glue(text: string, tokens: WordToken[]): WordToken[] {
  const out: WordToken[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (prev) {
      const between = text.slice(prev.end, t.start);
      if (/^['’‐‑-]$/.test(between)) {
        prev.end = t.end;
        continue;
      }
    }
    out.push({ ...t });
  }
  return out;
}

/** Blocks that carry no readable characters are rendered but never spoken. */
function isSpeakable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export function segmentChapter(chapter: Chapter): SegmentedChapter {
  const sentences: Sentence[] = [];
  const blockSentences: number[][] = [];

  chapter.blocks.forEach((block, blockIndex) => {
    const indices: number[] = [];
    // An image is never spoken, however long its alt text; only a caption,
    // when there is one, reads like an ordinary paragraph.
    const spokenText = block.kind === "image" ? (block.caption ?? "") : block.text;
    let parts = spokenText.length ? splitSentences(spokenText) : [];
    // A heading's own punctuation ("Act III. Scene II.") can read like two
    // sentences to the splitter above, but a heading is one line, spoken
    // whole, and an override can only attach to a single sentence — so a
    // heading that carries one stays whole rather than losing it to a split
    // the heading never asked for.
    if (/^h[1-3]$/.test(block.kind) && block.speakable && parts.length > 1) parts = [spokenText];
    // A block-level override (currently just a roman numeral read as a word)
    // replaces the sentence text wholesale, so it only applies when the
    // whole block is one sentence: splitting it further would leave no
    // single part to attach it to.
    const override = block.speakable && parts.length === 1 ? block.speakable.trim() : null;
    for (const part of parts) {
      if (!part.length) continue;
      const trimmed = part.trim();
      const speakable = override ?? trimmed;
      const lead = part.indexOf(trimmed);
      const index = sentences.length;

      let words: WordToken[];
      let speakableWords: WordToken[];
      if (speakable === trimmed) {
        words = isSpeakable(trimmed) ? tokenizeWords(trimmed) : [];
        speakableWords = words;
      } else {
        const displayWords = isSpeakable(trimmed) ? tokenizeWords(trimmed) : [];
        const spokenWords = isSpeakable(speakable) ? tokenizeWords(speakable) : [];
        // Word i on the page is word i in speech only when the rewrite
        // didn't change how many tokens there are (true for a roman numeral,
        // which is always one token whichever way it's written). When it
        // isn't true there is no honest index to hand the synchronizer, so
        // the sentence plays without a highlight rather than lighting the
        // wrong word.
        const aligned = displayWords.length === spokenWords.length;
        words = aligned ? displayWords : [];
        speakableWords = aligned ? spokenWords : [];
      }

      sentences.push({
        index,
        blockIndex,
        text: part,
        speakable,
        lead: lead < 0 ? 0 : lead,
        words,
        speakableWords,
      });
      indices.push(index);
    }
    blockSentences.push(indices);
  });

  return { blocks: chapter.blocks, sentences, blockSentences };
}

/** Map a char index reported by a boundary event onto a word. */
export function wordAtCharIndex(words: WordToken[], charIndex: number): number {
  if (!words.length) return 0;
  let lo = 0;
  let hi = words.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= charIndex) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Where a sentence's spoken text begins for a given start word: the very
 * start of the sentence when beginning it fresh, even if the first word
 * token itself starts a character or two in (an opening quote or bracket
 * precedes it) — never sliced away, because a passage plan built while this
 * sentence was still ahead of playback offered its text whole, and the two
 * have to agree exactly or the engine treats this as an unplanned sentence
 * and fetches it alone. Resuming after a tap on a later word is still a
 * real slice, from that word's own offset.
 */
export function speechStartOffset(words: WordToken[], startWord: number): number {
  if (startWord <= 0) return 0;
  return words[startWord]?.start ?? 0;
}
