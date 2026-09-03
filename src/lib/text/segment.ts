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
  words: WordToken[];
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

function splitSentences(text: string): string[] {
  const seg = segmenter("sentence");
  if (!seg) return splitSentencesFallback(text);
  const parts: string[] = [];
  for (const s of seg.segment(text)) parts.push(s.segment);
  return parts.length ? parts : splitSentencesFallback(text);
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
    const parts = block.text.length ? splitSentences(block.text) : [];
    for (const part of parts) {
      if (!part.length) continue;
      const speakable = part.trim();
      const lead = part.indexOf(speakable);
      const index = sentences.length;
      sentences.push({
        index,
        blockIndex,
        text: part,
        speakable,
        lead: lead < 0 ? 0 : lead,
        words: isSpeakable(speakable) ? tokenizeWords(speakable) : [],
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
