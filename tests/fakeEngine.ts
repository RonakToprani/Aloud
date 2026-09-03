import type {
  EngineVoice,
  SpeakCallbacks,
  SpeakOptions,
  SpeechEngine,
  UtteranceHandle,
} from "@/lib/speech/engine";

export type Behaviour =
  /** Chrome and Edge: a boundary event for every word. */
  | "events"
  /** iOS Safari with many voices: onstart, audio, onend, no boundaries. */
  | "silent"
  /** Boundaries that dry up part-way through the utterance. */
  | "stops-midway"
  /** Synthesis that starts and then never reports anything again. */
  | "dead"
  /** Safari's instant, silent "end" — the utterance never really played. */
  | "phantom";

export interface SpokenRequest {
  text: string;
  rate: number;
  voiceId: string | null;
}

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

export class FakeEngine implements SpeechEngine {
  readonly id = "fake";
  readonly providesWordTimings = false;
  readonly supported = true;

  behaviour: Behaviour = "events";
  msPerWord = 40;
  /** Set when pause() should be ignored, as Safari sometimes does. */
  ignorePause = false;

  readonly spoken: SpokenRequest[] = [];
  private speaking = false;
  private paused = false;
  private timers = new Set<ReturnType<typeof setTimeout>>();

  ready() {
    return Promise.resolve();
  }
  listVoices(): EngineVoice[] {
    return [];
  }
  subscribeVoices() {
    return () => {};
  }
  unlock() {}

  private later(fn: () => void, ms: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  speak(options: SpeakOptions, callbacks: SpeakCallbacks): UtteranceHandle {
    this.spoken.push({ text: options.text, rate: options.rate, voiceId: options.voiceId });
    this.speaking = true;
    this.paused = false;

    let cancelled = false;
    const handle: UtteranceHandle = {
      cancel: () => {
        cancelled = true;
        this.speaking = false;
      },
      get done() {
        return cancelled;
      },
    };

    WORD_RE.lastIndex = 0;
    const starts: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = WORD_RE.exec(options.text))) starts.push(match.index);

    this.later(() => {
      if (cancelled) return;
      callbacks.onStart?.();

      if (this.behaviour === "phantom") {
        this.speaking = false;
        callbacks.onEnd?.();
        return;
      }
      if (this.behaviour === "dead") return;

      const emitting =
        this.behaviour === "events"
          ? starts
          : this.behaviour === "stops-midway"
            ? starts.slice(0, 2)
            : [];

      emitting.forEach((charIndex, index) => {
        this.later(() => {
          if (cancelled) return;
          callbacks.onBoundary?.({ charIndex, charLength: 0, elapsed: index * this.msPerWord });
        }, index * this.msPerWord);
      });

      this.later(
        () => {
          if (cancelled) return;
          this.speaking = false;
          callbacks.onEnd?.();
        },
        Math.max(1, starts.length) * this.msPerWord,
      );
    }, 8);

    return handle;
  }

  pause() {
    if (this.ignorePause) return;
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  cancel() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.speaking = false;
    this.paused = false;
  }
  isSpeaking() {
    return this.speaking;
  }
  isPaused() {
    return this.paused;
  }
  destroy() {
    this.cancel();
  }
}
