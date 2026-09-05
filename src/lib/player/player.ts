import type { SpeechEngine, SpeechError, UtteranceHandle } from "@/lib/speech/engine";
import { SentenceSynchronizer, type SyncMode } from "@/lib/speech/synchronizer";
import type { SegmentedChapter } from "@/lib/text/segment";

export type PlayerStatus = "idle" | "playing" | "paused" | "ended";

export interface PlayerState {
  status: PlayerStatus;
  chapterIndex: number;
  sentenceIndex: number;
  wordIndex: number;
  /** Which timing strategy is live, for diagnostics. */
  syncMode: SyncMode;
  error: SpeechError | null;
}

export interface PlayerOptions {
  engine: SpeechEngine;
  /** Chapters are segmented on demand: a novel shouldn't be tokenised whole
   *  just to start reading its third chapter. */
  getChapter: (index: number) => SegmentedChapter | undefined;
  chapterCount: number;
  rate: number;
  voiceId: string | null;
  onState: (state: PlayerState) => void;
  /** Fires once per sentence so the reader can persist and auto-scroll. */
  onSentence?: (chapterIndex: number, sentenceIndex: number) => void;
}

/** How long we give a native pause() before deciding Safari ignored it. */
const PAUSE_VERIFY_MS = 300;
const RESUME_VERIFY_MS = 450;
/** An utterance that "ends" this fast never actually spoke. Judged against
 *  the sentence's own estimate as well as an absolute floor, so a genuinely
 *  short sentence at 2.5x is never mistaken for a failure. */
const PHANTOM_END_MS = 250;
const PHANTOM_END_FRACTION = 0.15;
const MAX_RECOVERIES = 3;
/** If the engine has not started speaking by now, it never will. */
const START_TIMEOUT_MS = 2500;

/**
 * Owns playback: one sentence per utterance, chained on end.
 *
 * Chaining rather than queueing ahead is deliberate. Safari's pause(),
 * cancel() and utterance queue interact badly once more than one utterance is
 * outstanding, and the gap between sentence utterances reads as natural
 * sentence spacing anyway.
 */
export class Player {
  private state: PlayerState;
  private handle: UtteranceHandle | null = null;
  private sync: SentenceSynchronizer | null = null;
  private rate: number;
  private voiceId: string | null;
  private pausedByCancel = false;
  private recoveries = 0;
  private verifyTimer: ReturnType<typeof setTimeout> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(private options: PlayerOptions) {
    this.rate = options.rate;
    this.voiceId = options.voiceId;
    this.state = {
      status: "idle",
      chapterIndex: 0,
      sentenceIndex: 0,
      wordIndex: 0,
      syncMode: "pending",
      error: null,
    };
  }

  getState(): PlayerState {
    return this.state;
  }

  private emit(patch: Partial<PlayerState>): void {
    this.state = { ...this.state, ...patch };
    this.options.onState(this.state);
  }

  private chapter(index = this.state.chapterIndex): SegmentedChapter | undefined {
    if (index < 0 || index >= this.options.chapterCount) return undefined;
    return this.options.getChapter(index);
  }

  /** Move the cursor without starting or stopping playback. */
  seek(chapterIndex: number, sentenceIndex: number, wordIndex = 0): void {
    const chapter = this.chapter(chapterIndex);
    if (!chapter) return;
    const bounded = Math.min(Math.max(0, sentenceIndex), Math.max(0, chapter.sentences.length - 1));
    const sentence = chapter.sentences[bounded];
    const word = sentence ? Math.min(Math.max(0, wordIndex), Math.max(0, sentence.words.length - 1)) : 0;
    this.emit({
      chapterIndex,
      sentenceIndex: bounded,
      wordIndex: word,
      error: null,
    });
    this.options.onSentence?.(chapterIndex, bounded);

    // Warm the sentence under the cursor while nothing is playing, so pressing
    // play is instant instead of paying a network round trip in silence. While
    // playing this is left alone: the lookahead slot belongs to the *next*
    // sentence, and stealing it would reintroduce the gap it exists to remove.
    if (this.state.status !== "playing") this.prefetchAt(chapterIndex, bounded);
  }

  /** Seek and play in one gesture — what tapping a word does. */
  playFrom(chapterIndex: number, sentenceIndex: number, wordIndex = 0): void {
    this.stopSpeaking();
    this.seek(chapterIndex, sentenceIndex, wordIndex);
    this.recoveries = 0;
    this.speakCurrent();
  }

  play(): void {
    if (this.state.status === "playing") return;
    if (this.state.status === "paused") {
      this.resume();
      return;
    }
    this.recoveries = 0;
    this.speakCurrent();
  }

  toggle(): void {
    if (this.state.status === "playing") this.pause();
    else this.play();
  }

  pause(): void {
    if (this.state.status !== "playing") return;
    this.clearVerify();
    this.sync?.pause();
    this.options.engine.pause();
    this.emit({ status: "paused" });

    // Safari sometimes accepts pause() and keeps talking. Verify, and if the
    // engine ignored us, stop hard and resume by re-speaking instead.
    this.verifyTimer = setTimeout(() => {
      if (this.destroyed || this.state.status !== "paused") return;
      const engine = this.options.engine;
      if (engine.isSpeaking() && !engine.isPaused()) {
        this.pausedByCancel = true;
        this.stopSpeaking();
      }
    }, PAUSE_VERIFY_MS);
  }

  resume(): void {
    if (this.state.status !== "paused") return;
    this.clearVerify();

    if (this.pausedByCancel) {
      this.pausedByCancel = false;
      this.speakCurrent();
      return;
    }

    this.sync?.resume();
    this.options.engine.resume();
    this.emit({ status: "playing" });

    // If resume() silently failed, re-speak the current sentence from where
    // the highlight stopped rather than leaving the reader in silence.
    this.verifyTimer = setTimeout(() => {
      if (this.destroyed || this.state.status !== "playing") return;
      if (!this.options.engine.isSpeaking() || this.options.engine.isPaused()) {
        this.speakCurrent();
      }
    }, RESUME_VERIFY_MS);
  }

  stop(): void {
    this.stopSpeaking();
    this.emit({ status: "idle" });
  }

  nextSentence(): void {
    this.step(1);
  }

  previousSentence(): void {
    // Matches every audio player: go to the start of this sentence first.
    if (this.state.wordIndex > 2) {
      this.jumpTo(this.state.chapterIndex, this.state.sentenceIndex);
      return;
    }
    this.step(-1);
  }

  goToChapter(chapterIndex: number): void {
    if (!this.chapter(chapterIndex)) return;
    this.jumpTo(chapterIndex, 0);
  }

  setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;
    // A rate change only takes effect on a new utterance.
    if (this.state.status === "playing") this.speakCurrent();
  }

  setVoice(voiceId: string | null): void {
    if (voiceId === this.voiceId) return;
    this.voiceId = voiceId;
    if (this.state.status === "playing") this.speakCurrent();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearVerify();
    this.stopSpeaking();
  }

  private step(direction: 1 | -1): void {
    const target = this.resolveSentence(
      this.state.chapterIndex,
      this.state.sentenceIndex + direction,
      direction,
    );
    if (!target) {
      if (direction > 0) this.finish();
      return;
    }
    this.jumpTo(target.chapterIndex, target.sentenceIndex);
  }

  private jumpTo(chapterIndex: number, sentenceIndex: number): void {
    const wasPlaying = this.state.status === "playing";
    this.stopSpeaking();
    this.seek(chapterIndex, sentenceIndex, 0);
    if (wasPlaying) {
      this.recoveries = 0;
      this.speakCurrent();
    }
  }

  /** Walk across chapter boundaries, skipping sentences with nothing to say. */
  private resolveSentence(
    chapterIndex: number,
    sentenceIndex: number,
    direction: 1 | -1,
  ): { chapterIndex: number; sentenceIndex: number } | null {
    let ci = chapterIndex;
    let si = sentenceIndex;

    for (let guard = 0; guard < 10000; guard++) {
      const chapter = this.chapter(ci);
      if (!chapter) return null;

      if (si < 0) {
        ci -= 1;
        const previous = this.chapter(ci);
        if (!previous) return null;
        si = previous.sentences.length - 1;
        continue;
      }
      if (si >= chapter.sentences.length) {
        ci += 1;
        if (!this.chapter(ci)) return null;
        si = 0;
        continue;
      }
      if (chapter.sentences[si].words.length) return { chapterIndex: ci, sentenceIndex: si };
      si += direction;
    }
    return null;
  }

  private stopSpeaking(): void {
    this.clearVerify();
    this.clearStartTimer();
    this.sync?.stop();
    this.sync = null;
    this.handle?.cancel();
    this.handle = null;
    this.options.engine.cancel();
  }

  private clearVerify(): void {
    if (this.verifyTimer) clearTimeout(this.verifyTimer);
    this.verifyTimer = null;
  }

  private clearStartTimer(): void {
    if (this.startTimer) clearTimeout(this.startTimer);
    this.startTimer = null;
  }

  private finish(): void {
    this.stopSpeaking();
    this.emit({ status: "ended" });
  }

  private speakCurrent(): void {
    if (this.destroyed) return;
    this.stopSpeaking();

    const target = this.resolveSentence(this.state.chapterIndex, this.state.sentenceIndex, 1);
    if (!target) {
      this.finish();
      return;
    }
    if (
      target.chapterIndex !== this.state.chapterIndex ||
      target.sentenceIndex !== this.state.sentenceIndex
    ) {
      this.seek(target.chapterIndex, target.sentenceIndex, 0);
    }

    const chapter = this.chapter(target.chapterIndex);
    const sentence = chapter?.sentences[target.sentenceIndex];
    if (!chapter || !sentence) {
      this.finish();
      return;
    }

    const startWord = Math.min(this.state.wordIndex, Math.max(0, sentence.words.length - 1));
    const offset = sentence.words[startWord]?.start ?? 0;
    const text = sentence.speakable.slice(offset);
    if (!text.trim()) {
      this.emit({ wordIndex: 0 });
      this.advance();
      return;
    }

    const sync = new SentenceSynchronizer({
      sentenceText: sentence.speakable,
      words: sentence.words,
      startWordIndex: startWord,
      rate: this.rate,
      voiceId: this.voiceId,
      onWord: (wordIndex) => {
        if (this.sync === sync) this.emit({ wordIndex });
      },
      onMode: (syncMode) => {
        if (this.sync === sync) this.emit({ syncMode });
      },
      onStall: () => {
        if (this.sync === sync) this.recover();
      },
    });
    this.sync = sync;

    this.emit({ status: "playing", error: null, syncMode: "pending" });
    this.options.onSentence?.(target.chapterIndex, target.sentenceIndex);

    // A voice the system lists but will not actually speak — Siri's, on iOS —
    // produces no events at all: no start, no end, no error. Without this the
    // reader just sees the highlight parked on the first word in silence.
    this.clearStartTimer();
    this.startTimer = setTimeout(() => {
      if (this.destroyed || this.sync !== sync) return;
      this.recover("silent");
    }, START_TIMEOUT_MS);

    this.handle = this.options.engine.speak(
      { text, voiceId: this.voiceId, rate: this.rate },
      {
        onStart: () => {
          if (this.sync !== sync) return;
          this.clearStartTimer();
          sync.start();
        },
        onBoundary: (event) => {
          if (this.sync !== sync) return;
          sync.boundary(event.charIndex);
        },
        onEnd: () => {
          if (this.sync !== sync) return;
          // end() settles the highlight on the last word, which is right for a
          // sentence that really played and wrong for one that never did.
          const wordBeforeEnd = sync.currentWord;
          const { actualMs, estimatedMs } = sync.end();
          this.sync = null;
          // A multi-word sentence that "finished" instantly never played.
          const phantomFloor = Math.min(PHANTOM_END_MS, estimatedMs * PHANTOM_END_FRACTION);
          if (actualMs < phantomFloor && sentence.words.length > 2) {
            // Rewind to where the voice actually was, so the retry speaks the
            // sentence rather than just its final word.
            this.emit({ wordIndex: wordBeforeEnd });
            this.recover();
            return;
          }
          // A sentence that really played clears the recovery budget. Doing
          // this on start instead would let an engine that keeps ending
          // instantly reset the budget forever and never surface an error.
          this.recoveries = 0;
          this.advance();
        },
        onError: (error) => {
          if (this.sync !== sync) return;
          this.handleError(error);
        },
      },
    );

    this.offerPassage(target.chapterIndex, target.sentenceIndex);
    this.prefetchNext(target.chapterIndex, target.sentenceIndex);
  }

  /** Lets an engine with real synthesis latency (a network voice) start
   *  fetching the next sentence while this one is still playing, so the
   *  round trip doesn't show up as a gap between sentences. */
  private prefetchNext(chapterIndex: number, sentenceIndex: number): void {
    const next = this.resolveSentence(chapterIndex, sentenceIndex + 1, 1);
    if (!next) return;
    this.prefetchAt(next.chapterIndex, next.sentenceIndex);
  }

  /** How many sentences ahead to offer for joint synthesis. The engine takes
   *  as many as fit whatever length it wants to synthesise at once. */
  private static readonly PASSAGE_LOOKAHEAD = 12;

  /** Hand the engine the sentences about to be read, so one that can
   *  synthesise a paragraph together does so rather than reading each sentence
   *  in isolation. */
  private offerPassage(chapterIndex: number, sentenceIndex: number): void {
    if (!this.options.engine.prepare) return;
    const texts: { text: string; endsParagraph: boolean }[] = [];
    let cursor: { chapterIndex: number; sentenceIndex: number } | null = {
      chapterIndex,
      sentenceIndex,
    };
    while (cursor && texts.length < Player.PASSAGE_LOOKAHEAD) {
      const chapter = this.chapter(cursor.chapterIndex);
      const sentence = chapter?.sentences[cursor.sentenceIndex];
      if (!sentence) break;
      // Passages never span a chapter: the voice should land at a chapter end.
      const next = this.resolveSentence(cursor.chapterIndex, cursor.sentenceIndex + 1, 1);
      const continues = next && next.chapterIndex === chapterIndex ? next : null;
      const nextSentence = continues
        ? this.chapter(continues.chapterIndex)?.sentences[continues.sentenceIndex]
        : undefined;
      texts.push({
        text: sentence.speakable,
        // The block a sentence belongs to is its paragraph; a change of block,
        // or running out of chapter, ends one.
        endsParagraph: !nextSentence || nextSentence.blockIndex !== sentence.blockIndex,
      });
      cursor = continues;
    }
    if (texts.length) {
      this.options.engine.prepare(texts, { voiceId: this.voiceId, rate: this.rate });
    }
  }

  /** Ask the engine to have this exact sentence ready to play. */
  private prefetchAt(chapterIndex: number, sentenceIndex: number): void {
    const target = this.resolveSentence(chapterIndex, sentenceIndex, 1);
    if (!target) return;
    const sentence = this.chapter(target.chapterIndex)?.sentences[target.sentenceIndex];
    if (!sentence?.speakable.trim()) return;
    const startWord = Math.min(this.state.wordIndex, Math.max(0, sentence.words.length - 1));
    const offset =
      target.sentenceIndex === this.state.sentenceIndex && target.chapterIndex === this.state.chapterIndex
        ? (sentence.words[startWord]?.start ?? 0)
        : 0;
    const text = sentence.speakable.slice(offset);
    if (!text.trim()) return;
    this.options.engine.prefetch?.({ text, voiceId: this.voiceId, rate: this.rate });
  }

  private advance(): void {
    const next = this.resolveSentence(this.state.chapterIndex, this.state.sentenceIndex + 1, 1);
    if (!next) {
      this.finish();
      return;
    }
    this.emit({
      chapterIndex: next.chapterIndex,
      sentenceIndex: next.sentenceIndex,
      wordIndex: 0,
    });
    this.speakCurrent();
  }

  /** Synthesis died, or never began — restart it from the current word. */
  private recover(reason: "stalled" | "silent" = "stalled"): void {
    this.stopSpeaking();
    if (this.recoveries >= MAX_RECOVERIES) {
      this.emit({
        status: "paused",
        error: {
          kind: reason === "silent" ? "no-voices" : "synthesis-failed",
          message:
            reason === "silent"
              ? "This voice produced no sound. On iPhone, Siri voices are reserved by the system and can't be used by websites — open Voice & speed and pick another."
              : "The voice stopped responding. This happens occasionally on iOS — press play to pick up where you left off.",
        },
      });
      return;
    }
    this.recoveries += 1;
    setTimeout(() => {
      if (this.destroyed || this.state.status === "idle") return;
      this.speakCurrent();
    }, 220);
  }

  private handleError(error: SpeechError): void {
    if (error.kind === "interrupted") return;
    if (error.kind === "synthesis-failed") {
      this.recover();
      return;
    }
    this.stopSpeaking();
    this.emit({ status: "paused", error });
  }
}
