import type { WordToken } from "@/lib/text/segment";

/** Baseline speech model, tuned against Chrome and macOS system voices at
 *  rate 1.0. Everything here is scaled by a per-voice calibration factor that
 *  the synchronizer learns from real utterance durations. */
const BASE_WORD_MS = 90;
const MS_PER_CHAR = 52;
const PAUSE_MS: Record<string, number> = {
  ",": 150,
  ";": 200,
  ":": 200,
  "—": 170,
  "–": 140,
  "-": 40,
  ".": 300,
  "!": 300,
  "?": 300,
  "…": 280,
};

function trailingPause(text: string, from: number, to: number): number {
  let pause = 0;
  for (let i = from; i < to; i++) {
    const ms = PAUSE_MS[text[i]];
    if (ms) pause = Math.max(pause, ms);
  }
  return pause;
}

/** Per-word durations in ms, including the pause that follows each word. */
export function estimateWordDurations(
  text: string,
  words: WordToken[],
  rate: number,
  calibration: number,
): number[] {
  const scale = calibration / Math.max(0.1, rate);
  return words.map((word, i) => {
    const length = word.end - word.start;
    const nextStart = i + 1 < words.length ? words[i + 1].start : text.length;
    const spoken = BASE_WORD_MS + MS_PER_CHAR * length;
    const pause = trailingPause(text, word.end, nextStart);
    return (spoken + pause) * scale;
  });
}

const STORAGE_KEY = "aloud.timing-calibration.v1";
const DEFAULT = 1;
const MIN = 0.45;
const MAX = 2.6;
const ALPHA = 0.25;

type CalibrationMap = Record<string, number>;

let cache: CalibrationMap | null = null;

function load(): CalibrationMap {
  if (cache) return cache;
  cache = {};
  if (typeof localStorage === "undefined") return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cache = parsed as CalibrationMap;
    }
  } catch {
    /* a corrupt entry just means we relearn from scratch */
  }
  return cache;
}

function save(): void {
  if (typeof localStorage === "undefined" || !cache) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* quota or private mode — calibration stays in memory for this session */
  }
}

function key(voiceId: string | null): string {
  return voiceId ?? "__default__";
}

export function getCalibration(voiceId: string | null): number {
  const value = load()[key(voiceId)];
  return typeof value === "number" && value >= MIN && value <= MAX ? value : DEFAULT;
}

/** Fold one observed sentence duration into the running estimate. */
export function recordCalibration(
  voiceId: string | null,
  estimatedMs: number,
  actualMs: number,
): number {
  // Very short utterances are dominated by engine startup latency and teach
  // the model nothing useful.
  if (estimatedMs < 350 || actualMs < 350) return getCalibration(voiceId);
  const ratio = actualMs / estimatedMs;
  if (!Number.isFinite(ratio) || ratio < 0.25 || ratio > 4) return getCalibration(voiceId);

  const map = load();
  const previous = getCalibration(voiceId);
  const next = Math.min(MAX, Math.max(MIN, previous * (1 - ALPHA) + previous * ratio * ALPHA));
  map[key(voiceId)] = next;
  save();
  return next;
}
