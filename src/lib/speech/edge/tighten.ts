/**
 * Tightening the silences in synthesised audio.
 *
 * Measured against the live endpoint, Edge's neural voices leave 950–1175ms
 * of silence after every sentence, ~200ms before the first word and ~900ms
 * after the last. Read back to back that lands as a pause you could drive
 * through — a good human narrator sits nearer 350–450ms between sentences,
 * a little longer at a paragraph. The endpoint refuses SSML that would
 * shorten the pauses, so they are shortened in the decoded audio instead:
 * every silent run is found, and the ones longer than they should be lose
 * their middle. Splicing silence to silence is inaudible, and the word
 * timings are shifted to match.
 *
 * Everything here is pure arithmetic over sample arrays so it can be tested
 * in Node; the engine wraps it around AudioBuffers.
 */

export interface TimedWordLike {
  charIndex: number;
  charLength: number;
  offsetMs: number;
  durationMs: number;
}

export interface SentenceSpan {
  /** Character range within the text the words address. */
  start: number;
  end: number;
  /** True when a paragraph ends after this sentence. */
  endsParagraph: boolean;
}

/** A stretch of audio to remove, in milliseconds of the original. */
export interface Cut {
  fromMs: number;
  toMs: number;
}

export interface TightenSettings {
  /** RMS below which a 5ms frame counts as silence. */
  silenceRms: number;
  frameMs: number;
  /** Runs shorter than this are left alone: they are phrasing, not gaps. */
  minRunMs: number;
  /** What a silent run is cut down to, by what it separates. */
  sentencePauseMs: number;
  paragraphPauseMs: number;
  /** A long pause that isn't at a sentence end — a dash, a colon, a list. */
  otherPauseMs: number;
  leadMs: number;
  /** Silence left after the last word. Null keeps the natural tail. */
  trailMs: number | null;
}

export const DEFAULT_TIGHTEN: TightenSettings = {
  silenceRms: 0.006,
  frameMs: 5,
  minRunMs: 450,
  sentencePauseMs: 380,
  paragraphPauseMs: 620,
  otherPauseMs: 480,
  leadMs: 40,
  trailMs: 0,
};

/** Word timings arrive ~100–170ms ahead of the audible onset, so a boundary
 *  is matched to a silent run with this much slack either side. */
const BOUNDARY_SLACK_MS = 350;

interface SilentRun {
  fromMs: number;
  toMs: number;
}

/** Every stretch of silence in the signal, in ms. */
export function findSilentRuns(
  samples: Float32Array,
  sampleRate: number,
  settings: TightenSettings = DEFAULT_TIGHTEN,
): SilentRun[] {
  const frame = Math.max(1, Math.round((sampleRate * settings.frameMs) / 1000));
  const frames = Math.floor(samples.length / frame);
  const runs: SilentRun[] = [];
  let runStart: number | null = null;
  for (let f = 0; f <= frames; f++) {
    let silent: boolean;
    if (f === frames) {
      silent = false; // sentinel: close any open run at the end
    } else {
      let energy = 0;
      const base = f * frame;
      for (let i = 0; i < frame; i++) energy += samples[base + i] * samples[base + i];
      silent = Math.sqrt(energy / frame) < settings.silenceRms;
    }
    if (silent && runStart === null) runStart = f;
    if (!silent && runStart !== null) {
      runs.push({ fromMs: runStart * settings.frameMs, toMs: f * settings.frameMs });
      runStart = null;
    }
  }
  // A signal that ends silent closes its run at the true end, not a frame short.
  const last = runs[runs.length - 1];
  if (last && last.toMs >= frames * settings.frameMs - settings.frameMs) {
    last.toMs = (samples.length / sampleRate) * 1000;
  }
  return runs;
}

/** Where each sentence's words start and stop, by the timings. */
function sentenceEdges(words: TimedWordLike[], sentences: SentenceSpan[]) {
  return sentences.map((sentence) => {
    const inside = words.filter((w) => w.charIndex >= sentence.start && w.charIndex < sentence.end);
    const first = inside[0];
    const last = inside[inside.length - 1];
    return {
      firstMs: first ? first.offsetMs : null,
      lastEndMs: last ? last.offsetMs + last.durationMs : null,
      endsParagraph: sentence.endsParagraph,
    };
  });
}

/**
 * Decide which silences to shorten, and by how much. Cuts always come out of
 * the middle of a run, so the audio on either side of a splice is silence.
 */
export function planCuts(
  samples: Float32Array,
  sampleRate: number,
  words: TimedWordLike[],
  sentences: SentenceSpan[],
  settings: TightenSettings = DEFAULT_TIGHTEN,
): Cut[] {
  const totalMs = (samples.length / sampleRate) * 1000;
  const runs = findSilentRuns(samples, sampleRate, settings);
  const edges = sentenceEdges(words, sentences);
  const cuts: Cut[] = [];

  const lastWordEnd = words.length
    ? Math.max(...words.map((w) => w.offsetMs + w.durationMs))
    : 0;

  for (const run of runs) {
    const length = run.toMs - run.fromMs;
    const isLead = run.fromMs === 0;
    const isTail = run.toMs >= totalMs - settings.frameMs;

    if (isLead) {
      if (length > settings.leadMs) cuts.push({ fromMs: 0, toMs: length - settings.leadMs });
      continue;
    }
    if (isTail) {
      // Only silence past the last word is a tail; a trailing run that the
      // timings say still holds a word is left alone.
      const from = Math.max(run.fromMs, lastWordEnd - BOUNDARY_SLACK_MS);
      if (settings.trailMs === null || from >= run.toMs) continue;
      const keepTo = from + settings.trailMs;
      if (run.toMs > keepTo) cuts.push({ fromMs: keepTo, toMs: run.toMs });
      continue;
    }
    if (length < settings.minRunMs) continue;

    // Which sentence boundary, if any, does this run sit on?
    let target = settings.otherPauseMs;
    for (let i = 0; i + 1 < edges.length; i++) {
      const a = edges[i];
      const b = edges[i + 1];
      if (a.lastEndMs === null || b.firstMs === null) continue;
      if (run.fromMs >= a.lastEndMs - BOUNDARY_SLACK_MS && run.toMs <= b.firstMs + BOUNDARY_SLACK_MS) {
        target = a.endsParagraph ? settings.paragraphPauseMs : settings.sentencePauseMs;
        break;
      }
    }
    if (length <= target) continue;
    const excess = length - target;
    const middle = run.fromMs + (length - excess) / 2;
    cuts.push({ fromMs: middle, toMs: middle + excess });
  }
  return cuts;
}

/** Original ms → ms in the tightened audio. */
export function remapMs(ms: number, cuts: Cut[]): number {
  let removed = 0;
  for (const cut of cuts) {
    if (cut.toMs <= ms) removed += cut.toMs - cut.fromMs;
    else if (cut.fromMs < ms) removed += ms - cut.fromMs; // inside a cut: land on the splice
  }
  return Math.max(0, ms - removed);
}

export function remapWords<T extends TimedWordLike>(words: T[], cuts: Cut[]): T[] {
  return words.map((word) => {
    const start = remapMs(word.offsetMs, cuts);
    const end = remapMs(word.offsetMs + word.durationMs, cuts);
    return { ...word, offsetMs: start, durationMs: Math.max(0, end - start) };
  });
}

/** Total ms removed. */
export function removedMs(cuts: Cut[]): number {
  return cuts.reduce((sum, cut) => sum + (cut.toMs - cut.fromMs), 0);
}

/** Copy the samples that survive the cuts into a new array. */
export function applyCuts(samples: Float32Array, sampleRate: number, cuts: Cut[]): Float32Array {
  const toSample = (ms: number) => Math.min(samples.length, Math.max(0, Math.round((ms / 1000) * sampleRate)));
  const ordered = [...cuts].sort((a, b) => a.fromMs - b.fromMs);
  let kept = samples.length;
  for (const cut of ordered) kept -= toSample(cut.toMs) - toSample(cut.fromMs);
  const out = new Float32Array(Math.max(0, kept));
  let read = 0;
  let write = 0;
  for (const cut of ordered) {
    const from = toSample(cut.fromMs);
    const to = toSample(cut.toMs);
    if (from > read) {
      out.set(samples.subarray(read, from), write);
      write += from - read;
    }
    read = Math.max(read, to);
  }
  if (read < samples.length) out.set(samples.subarray(read), write);
  return out;
}
