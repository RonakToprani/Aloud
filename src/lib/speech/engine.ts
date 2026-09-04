/** The seam between the reader and whatever produces audio.
 *
 *  The Web Speech implementation lives in `webSpeechEngine.ts`. A future
 *  Piper-over-WebSocket implementation would satisfy the same interface and
 *  set `providesWordTimings = true`; nothing above this file knows which one
 *  is in play. */

/** How good a voice actually sounds, which on Apple platforms can only be
 *  read from the voiceURI rather than the name. */
export type VoiceTier =
  /** Apple Premium — the best on-device voices, downloaded by the reader. */
  | "premium"
  /** Apple Enhanced, or a vendor's neural/natural voice. */
  | "enhanced"
  /** Everything else usable: Google, Microsoft, most desktop voices. */
  | "standard"
  /** Apple's small always-installed voices. Intelligible, obviously synthetic. */
  | "compact"
  /** Listed on some systems but reserved for Siri; unusable from a web page. */
  | "siri"
  /** Eloquence and the old joke voices. Never a sensible default. */
  | "novelty";

export interface EngineVoice {
  /** Stable across reloads on the same device. */
  id: string;
  name: string;
  lang: string;
  /** Installed on the device rather than streamed from a server. */
  local: boolean;
  isDefault: boolean;
  tier: VoiceTier;
  /** What the provider says this voice is built for, when it says anything —
   *  Microsoft tags its cloud voices "Novel", "News", "Conversation" and so
   *  on. Empty for on-device voices, which carry no such metadata. */
  traits?: string[];
  /** 0..1, derived from the tier; used only for ordering the picker. */
  quality: number;
}

export interface SpeakOptions {
  text: string;
  voiceId: string | null;
  rate: number;
  pitch?: number;
  volume?: number;
}

export interface BoundaryEvent {
  /** Offset into the text passed to `speak`. */
  charIndex: number;
  charLength: number;
  /** ms since this utterance started, measured by the engine wrapper. */
  elapsed: number;
}

export type SpeechErrorKind =
  | "not-allowed"
  | "no-voices"
  | "synthesis-failed"
  | "interrupted"
  | "unknown";

export interface SpeechError {
  kind: SpeechErrorKind;
  message: string;
}

export interface SpeakCallbacks {
  onStart?: () => void;
  onBoundary?: (event: BoundaryEvent) => void;
  onEnd?: () => void;
  onError?: (error: SpeechError) => void;
}

export interface UtteranceHandle {
  /** Stop this utterance and suppress any further callbacks from it. */
  cancel(): void;
  readonly done: boolean;
}

export interface SpeechEngine {
  readonly id: string;
  /** When true the synchronizer can trust word timings unconditionally. */
  readonly providesWordTimings: boolean;
  readonly supported: boolean;

  /** Resolves once voices are known (or we've given up waiting for them). */
  ready(): Promise<void>;
  listVoices(): EngineVoice[];
  subscribeVoices(listener: (voices: EngineVoice[]) => void): () => void;

  /** Must be called from inside a user gesture on iOS before the first speak. */
  unlock(): void;

  /** Optional lookahead: start preparing a sentence that isn't playing yet,
   *  so a later `speak()` call for it doesn't pay for synthesis latency. Only
   *  worth implementing for an engine whose speak() has a real round trip;
   *  on-device engines have nothing to gain from it. */
  prefetch?(options: SpeakOptions): void;

  /**
   * Optional. Offers the run of sentences about to be read, so an engine that
   * can synthesise several together does so.
   *
   * A sentence synthesised alone is given a full terminal fall and a fresh
   * starting pitch, because the model has no idea anything follows. Read back
   * to back that lands as a list of separate statements rather than prose, and
   * no amount of tightening the gaps between clips fixes it — the problem is
   * inside the audio. Handing over the whole paragraph lets the model shape
   * the intonation across it.
   *
   * The first entry is the sentence `speak` will be called with next. Engines
   * that synthesise one sentence at a time simply omit this.
   */
  prepare?(texts: string[], options: Omit<SpeakOptions, "text">): void;

  speak(options: SpeakOptions, callbacks: SpeakCallbacks): UtteranceHandle;
  pause(): void;
  resume(): void;
  cancel(): void;
  isSpeaking(): boolean;
  isPaused(): boolean;
  destroy(): void;
}
