/** The seam between the reader and whatever produces audio.
 *
 *  The Web Speech implementation lives in `webSpeechEngine.ts`. A future
 *  Piper-over-WebSocket implementation would satisfy the same interface and
 *  set `providesWordTimings = true`; nothing above this file knows which one
 *  is in play. */

export interface EngineVoice {
  /** Stable across reloads on the same device. */
  id: string;
  name: string;
  lang: string;
  /** Installed on the device rather than streamed from a server. */
  local: boolean;
  isDefault: boolean;
  /** 0..1 heuristic used only for ordering the picker. */
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

  speak(options: SpeakOptions, callbacks: SpeakCallbacks): UtteranceHandle;
  pause(): void;
  resume(): void;
  cancel(): void;
  isSpeaking(): boolean;
  isPaused(): boolean;
  destroy(): void;
}
