/**
 * Word timings for a voice that gives none.
 *
 * Kokoro returns a waveform and nothing about where the words fall in it.
 * The reader lights each word as it is spoken, so the words have to be
 * placed, and placing them by letter count alone drifts badly: "through"
 * is one syllable and "idea" is three. Phonemes are what the voice actually
 * spends time on, so each word is weighted by its phoneme count, with a
 * fixed cost per word for the small gap speech leaves between words, and
 * the clip's voiced stretch is divided in those proportions.
 *
 * The real pauses in the audio are better evidence than any estimate. A
 * pause the voice took at a comma is a silent run in the signal, and the
 * written comma says which word it follows; where the two can be matched,
 * the words on either side are anchored to the measured pause and only the
 * stretch between anchors is estimated. Everything here is arithmetic over
 * sample arrays so it can be tested in Node.
 */

export interface AlignedWord {
  charIndex: number;
  charLength: number;
  offsetMs: number;
  durationMs: number;
}

export interface WordToken {
  text: string;
  charIndex: number;
}

export interface SilentRun {
  fromMs: number;
  toMs: number;
}

/** A word's cost in phonemes, as the caller measured it, or null when the
 *  phonemiser had nothing to say about it. */
export type PhonemeCount = number | null;

export const ALIGN_DEFAULTS = {
  /** RMS below which a frame is silence. Kokoro's floor is near digital
   *  zero, so this is well above it and below any breath. */
  silenceRms: 0.008,
  frameMs: 5,
  /** A silent run shorter than this is a stop consonant, not a pause. */
  minPauseMs: 110,
  /** Silence kept before the first word and after the last, so a clip does
   *  not start with a click. */
  leadMs: 40,
  trailMs: 20,
  /** Time a word costs regardless of its length. */
  wordBaseMs: 55,
  /** Time each phoneme costs, before scaling to the clip. */
  phonemeMs: 70,
} as const;

export type AlignSettings = typeof ALIGN_DEFAULTS;

/** Every stretch of silence in the signal, in ms. */
export function findSilentRuns(
  samples: Float32Array,
  sampleRate: number,
  settings: Pick<AlignSettings, "silenceRms" | "frameMs"> = ALIGN_DEFAULTS,
): SilentRun[] {
  const frame = Math.max(1, Math.round((sampleRate * settings.frameMs) / 1000));
  const runs: SilentRun[] = [];
  let runStart: number | null = null;
  for (let i = 0; i < samples.length; i += frame) {
    const end = Math.min(samples.length, i + frame);
    let sum = 0;
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / (end - i));
    if (rms < settings.silenceRms) {
      if (runStart === null) runStart = i;
    } else if (runStart !== null) {
      runs.push({ fromMs: (runStart / sampleRate) * 1000, toMs: (i / sampleRate) * 1000 });
      runStart = null;
    }
  }
  if (runStart !== null) runs.push({ fromMs: (runStart / sampleRate) * 1000, toMs: (samples.length / sampleRate) * 1000 });
  return runs;
}

/** Where the voice begins and ends, in samples, with a little silence kept
 *  either side. An all-silent clip is returned whole. */
export function voicedBounds(
  samples: Float32Array,
  sampleRate: number,
  settings: AlignSettings = ALIGN_DEFAULTS,
): { start: number; end: number } {
  const runs = findSilentRuns(samples, sampleRate, settings);
  const totalMs = (samples.length / sampleRate) * 1000;
  let firstVoiceMs = 0;
  let lastVoiceMs = totalMs;
  if (runs.length && runs[0].fromMs === 0) firstVoiceMs = runs[0].toMs;
  const last = runs[runs.length - 1];
  if (last && last.toMs >= totalMs - 0.01) lastVoiceMs = last.fromMs;
  if (firstVoiceMs >= lastVoiceMs) return { start: 0, end: samples.length };
  const start = Math.max(0, Math.round(((firstVoiceMs - settings.leadMs) / 1000) * sampleRate));
  const end = Math.min(samples.length, Math.round(((lastVoiceMs + settings.trailMs) / 1000) * sampleRate));
  return { start, end };
}

/** The words of a sentence as the synchroniser sees them: runs of
 *  non-space, addressed by their offset into the text. */
export function tokenize(text: string): WordToken[] {
  const tokens: WordToken[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) tokens.push({ text: match[0], charIndex: match.index });
  return tokens;
}

/** Punctuation after which a voice takes a breath mid-sentence. */
const PAUSE_AFTER = /[,;:—–…]["'’”)]*$|\.\.\.["'’”)]*$|—$/;

/** True when the voice would pause after this word. */
export function pausesAfter(word: string): boolean {
  return PAUSE_AFTER.test(word);
}

/** Letters, as a stand-in for phonemes when the phonemiser fails. */
function letterCost(word: string): number {
  const letters = word.replace(/[^\p{L}\p{N}]/gu, "").length;
  // A letter is a little under a phoneme, English spelling being what it is.
  return Math.max(1, Math.round(letters * 0.8));
}

/**
 * Places the words across the voiced part of a clip.
 *
 * `voicedFromMs`..`voicedToMs` is where the speech is; `pauses` are the
 * silent runs inside it. The proportional estimate puts a boundary after
 * every word; each pause is then matched to the nearest boundary that
 * follows pause punctuation, if one is within reach, else to the nearest
 * boundary at all, and the estimate is re-stretched between the anchors.
 */
export function alignWords(
  tokens: WordToken[],
  phonemes: PhonemeCount[],
  voicedFromMs: number,
  voicedToMs: number,
  pauses: SilentRun[],
  settings: AlignSettings = ALIGN_DEFAULTS,
): AlignedWord[] {
  if (!tokens.length) return [];
  const span = Math.max(1, voicedToMs - voicedFromMs);

  // Each word's share of the speaking time, before any pause is known.
  const costs = tokens.map((token, i) => {
    const count = phonemes[i] ?? letterCost(token.text);
    return settings.wordBaseMs + Math.max(1, count) * settings.phonemeMs;
  });
  const totalCost = costs.reduce((sum, cost) => sum + cost, 0);
  const pauseTotal = pauses.reduce((sum, pause) => sum + (pause.toMs - pause.fromMs), 0);
  const speaking = Math.max(1, span - pauseTotal);

  // Cumulative speaking time at each word's end, in ms of speech (no pauses).
  const ends: number[] = [];
  let acc = 0;
  for (const cost of costs) {
    acc += (cost / totalCost) * speaking;
    ends.push(acc);
  }

  // Match pauses to word boundaries, in order, each to a boundary after the
  // previous one. Boundaries after pause punctuation are preferred when the
  // pause is anywhere near them; otherwise the nearest boundary is taken.
  const anchors: { boundary: number; pause: SilentRun }[] = [];
  let minBoundary = 0;
  const sorted = [...pauses].sort((a, b) => a.fromMs - b.fromMs);
  for (const pause of sorted) {
    // Where in speaking time this pause falls: its start, less the pauses
    // already anchored before it.
    const earlier = anchors.reduce((sum, a) => sum + (a.pause.toMs - a.pause.fromMs), 0);
    const at = pause.fromMs - voicedFromMs - earlier;
    let best = -1;
    let bestDistance = Infinity;
    for (let i = minBoundary; i < tokens.length - 1; i++) {
      const distance = Math.abs(ends[i] - at);
      // A punctuated boundary within reach beats a closer unpunctuated one,
      // because the writing says the pause is there.
      const weighted = pausesAfter(tokens[i].text) ? distance * 0.35 : distance;
      if (weighted < bestDistance) {
        bestDistance = weighted;
        best = i;
      }
    }
    // A pause the estimate puts more than two words away from any boundary
    // is not a word gap we can account for; leave it unanchored rather than
    // drag the words to it.
    if (best < 0 || bestDistance > Math.max(400, costs[best] * 2)) continue;
    anchors.push({ boundary: best, pause });
    minBoundary = best + 1;
  }

  // Re-stretch the estimate between anchors so the words before each pause
  // end exactly where the pause begins and the words after it start where it
  // ends.
  const result: AlignedWord[] = [];
  let segmentStartWord = 0;
  let segmentStartMs = voicedFromMs;
  let speechBefore = 0;
  const place = (fromWord: number, toWord: number, fromMs: number, toMs: number) => {
    const speechSpan = ends[toWord] - speechBefore;
    const scale = speechSpan > 0 ? (toMs - fromMs) / speechSpan : 0;
    let cursor = fromMs;
    for (let i = fromWord; i <= toWord; i++) {
      const prevEnd = i === 0 ? 0 : ends[i - 1];
      const duration = (ends[i] - prevEnd) * scale;
      result.push({
        charIndex: tokens[i].charIndex,
        charLength: tokens[i].text.length,
        offsetMs: Math.round(cursor),
        durationMs: Math.max(1, Math.round(duration)),
      });
      cursor += duration;
    }
  };
  for (const anchor of anchors) {
    place(segmentStartWord, anchor.boundary, segmentStartMs, anchor.pause.fromMs);
    speechBefore = ends[anchor.boundary];
    segmentStartWord = anchor.boundary + 1;
    segmentStartMs = anchor.pause.toMs;
  }
  place(segmentStartWord, tokens.length - 1, segmentStartMs, voicedToMs);
  return result;
}

/**
 * The whole job for one clip: trims it, finds its pauses, places the words.
 * Returns the trimmed sample range as well, so the caller stores only the
 * voice and not the silence the model padded it with.
 */
export function alignClip(
  text: string,
  samples: Float32Array,
  sampleRate: number,
  phonemes: PhonemeCount[],
  settings: AlignSettings = ALIGN_DEFAULTS,
): { start: number; end: number; words: AlignedWord[] } {
  const tokens = tokenize(text);
  const { start, end } = voicedBounds(samples, sampleRate, settings);
  const trimmed = samples.subarray(start, end);
  const runs = findSilentRuns(trimmed, sampleRate, settings);
  const totalMs = (trimmed.length / sampleRate) * 1000;
  const inside = runs.filter(
    (run) => run.fromMs > 0 && run.toMs < totalMs - 0.01 && run.toMs - run.fromMs >= settings.minPauseMs,
  );
  const voicedFrom = settings.leadMs;
  const voicedTo = Math.max(voicedFrom + 1, totalMs - settings.trailMs);
  const words = alignWords(tokens, phonemes, voicedFrom, voicedTo, inside, settings);
  return { start, end, words };
}

/** The most text the model takes in one go. Its tokenizer truncates at 510
 *  phonemes, silently, so a longer sentence would simply stop being read
 *  part way through; anything near that is split first. */
export const MAX_CHUNK_CHARS = 320;

export interface TextChunk {
  text: string;
  /** Offset of `text` within the sentence it came from. */
  charIndex: number;
}

/**
 * Splits an over-long sentence where a reader would breathe: after a comma,
 * semicolon, colon or dash, else at the last space that fits. Each chunk is
 * synthesised alone and the pieces are joined with a short gap, which at a
 * clause boundary is where the voice would have paused anyway.
 */
export function splitLongSentence(text: string, maxChars: number = MAX_CHUNK_CHARS): TextChunk[] {
  if (text.length <= maxChars) return [{ text, charIndex: 0 }];
  const chunks: TextChunk[] = [];
  let from = 0;
  while (text.length - from > maxChars) {
    const window = text.slice(from, from + maxChars);
    let cut = -1;
    for (const re of [/[,;:—–][^\s,;:—–]*\s(?![\s\S]*[,;:—–][^\s,;:—–]*\s)/, /\s(?!.*\s)/]) {
      const match = re.exec(window);
      if (match && match.index > maxChars * 0.3) {
        cut = match.index + match[0].length;
        break;
      }
    }
    if (cut <= 0) cut = maxChars;
    const piece = text.slice(from, from + cut);
    const lead = piece.length - piece.trimStart().length;
    chunks.push({ text: piece.trim(), charIndex: from + lead });
    from += cut;
  }
  const rest = text.slice(from);
  const lead = rest.length - rest.trimStart().length;
  if (rest.trim()) chunks.push({ text: rest.trim(), charIndex: from + lead });
  return chunks;
}
