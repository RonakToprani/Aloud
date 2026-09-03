import { estimateWordDurations, getCalibration, recordCalibration } from "./estimator";
import { wordAtCharIndex, type WordToken } from "@/lib/text/segment";

export type SyncMode = "pending" | "events" | "estimated";

export interface SynchronizerOptions {
  /** Full sentence text; word offsets are relative to it. */
  sentenceText: string;
  words: WordToken[];
  /** Index of the first word actually being spoken. */
  startWordIndex: number;
  rate: number;
  voiceId: string | null;
  onWord: (wordIndex: number) => void;
  onMode?: (mode: SyncMode) => void;
  /** The engine appears to have died without ever ending. */
  onStall?: () => void;
}

/** If nothing has fired by now, this engine isn't going to send boundaries. */
const BOUNDARY_GRACE_MS = 400;
/** Slack allowed on one word before we stop trusting boundary events. */
const BOUNDARY_STALL_FACTOR = 3;
const BOUNDARY_STALL_FLOOR_MS = 1400;
/** Slack on the whole sentence before we call the utterance dead. */
const DEATH_FACTOR = 2.4;
const DEATH_FLOOR_MS = 5000;

/**
 * Drives the word highlight for exactly one utterance.
 *
 * Two strategies sit behind one surface. Boundary events are used when the
 * engine sends them; otherwise a timer walks the words using per-word duration
 * estimates. Which one is live is decided at runtime from observed behaviour,
 * never from the user agent, and it can switch mid-sentence in either
 * direction rather than let the highlight sit still.
 */
export class SentenceSynchronizer {
  private mode: SyncMode = "pending";
  private startedAt = 0;
  private current: number;
  private readonly lastIndex: number;
  private readonly durations: number[];
  private readonly estimatedTotal: number;

  private wordEndsAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private deathTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pausedAt: number | null = null;
  private pausedOffset = 0;

  constructor(private options: SynchronizerOptions) {
    const { sentenceText, words, rate, voiceId, startWordIndex } = options;
    const calibration = getCalibration(voiceId);
    this.durations = estimateWordDurations(sentenceText, words, rate, calibration);
    this.lastIndex = Math.max(0, words.length - 1);
    this.current = Math.min(Math.max(0, startWordIndex), this.lastIndex);
    this.estimatedTotal = this.durations.slice(this.current).reduce((sum, ms) => sum + ms, 0);
  }

  get currentWord(): number {
    return this.current;
  }

  get strategy(): SyncMode {
    return this.mode;
  }

  /** Call from the utterance's onstart. */
  start(): void {
    if (this.stopped) return;
    this.startedAt = performance.now();
    this.options.onWord(this.current);
    if (!this.options.words.length) return;

    this.graceTimer = setTimeout(() => {
      if (this.stopped || this.mode !== "pending") return;
      this.switchToEstimated();
    }, BOUNDARY_GRACE_MS);

    this.armDeath();
  }

  /** Call from the utterance's onboundary. */
  boundary(charIndex: number): void {
    if (this.stopped || !this.options.words.length) return;

    if (this.mode !== "events") {
      this.setMode("events");
      this.clearTimer();
    }
    this.clearGrace();

    const base = this.options.words[this.options.startWordIndex]?.start ?? 0;
    const index = wordAtCharIndex(this.options.words, base + charIndex);

    // Engines occasionally re-announce or briefly regress; within a sentence
    // the highlight only ever moves forward.
    if (index > this.current) {
      this.current = Math.min(index, this.lastIndex);
      this.options.onWord(this.current);
    }
    this.armBoundaryStall();
  }

  /** Call from the utterance's onend. Returns the observed duration. */
  end(): { actualMs: number; estimatedMs: number } {
    const actualMs = this.startedAt ? performance.now() - this.startedAt - this.pausedOffset : 0;
    this.teardown();
    if (this.options.words.length && this.current < this.lastIndex) {
      this.current = this.lastIndex;
      this.options.onWord(this.current);
    }
    // Only the estimated path needs calibrating, and only from utterances that
    // ran start to finish without being paused.
    if (this.mode !== "events" && this.options.words.length > 2 && this.pausedOffset === 0) {
      recordCalibration(this.options.voiceId, this.estimatedTotal, actualMs);
    }
    return { actualMs, estimatedMs: this.estimatedTotal };
  }

  /** Freeze the estimated clock while the engine is paused. */
  pause(): void {
    if (this.stopped || this.pausedAt !== null) return;
    this.pausedAt = performance.now();
    this.clearTimer();
    this.clearStall();
    this.clearDeath();
  }

  resume(): void {
    if (this.stopped || this.pausedAt === null) return;
    this.pausedOffset += performance.now() - this.pausedAt;
    this.pausedAt = null;
    if (this.mode === "estimated") this.tick();
    this.armDeath();
  }

  stop(): void {
    this.stopped = true;
    this.teardown();
  }

  private elapsed(): number {
    const now = this.pausedAt ?? performance.now();
    return now - this.startedAt - this.pausedOffset;
  }

  private setMode(mode: SyncMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.options.onMode?.(mode);
  }

  private switchToEstimated(): void {
    this.setMode("estimated");
    // Anchor the clock wherever the highlight already is, so a mid-sentence
    // switch neither rewinds nor jumps.
    this.wordEndsAt = this.elapsed() + this.durations[this.current];
    this.tick();
  }

  private tick = (): void => {
    if (this.stopped || this.pausedAt !== null) return;
    this.clearTimer();

    const elapsed = this.elapsed();
    let moved = false;
    while (this.current < this.lastIndex && this.wordEndsAt <= elapsed) {
      this.current += 1;
      this.wordEndsAt += this.durations[this.current];
      moved = true;
    }
    if (moved) this.options.onWord(this.current);

    // The last word stays lit until the engine actually ends the utterance.
    if (this.current >= this.lastIndex) return;
    this.timer = setTimeout(this.tick, Math.max(16, this.wordEndsAt - elapsed));
  };

  private armBoundaryStall(): void {
    this.clearStall();
    if (this.current >= this.lastIndex) return;
    const budget = Math.max(
      BOUNDARY_STALL_FLOOR_MS,
      this.durations[this.current] * BOUNDARY_STALL_FACTOR,
    );
    this.stallTimer = setTimeout(() => {
      if (this.stopped || this.mode !== "events") return;
      // Boundary events dried up while the utterance is still running: keep
      // the highlight alive on estimates rather than leaving it parked.
      this.switchToEstimated();
    }, budget);
  }

  private armDeath(): void {
    this.clearDeath();
    this.deathTimer = setTimeout(
      () => {
        if (this.stopped) return;
        this.options.onStall?.();
      },
      this.estimatedTotal * DEATH_FACTOR + DEATH_FLOOR_MS,
    );
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private clearGrace(): void {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }
  private clearStall(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }
  private clearDeath(): void {
    if (this.deathTimer) clearTimeout(this.deathTimer);
    this.deathTimer = null;
  }
  private teardown(): void {
    this.clearTimer();
    this.clearGrace();
    this.clearStall();
    this.clearDeath();
  }
}
