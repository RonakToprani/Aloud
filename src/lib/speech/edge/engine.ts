import type {
  BoundaryEvent,
  EngineVoice,
  SpeakCallbacks,
  SpeakOptions,
  SpeechEngine,
  SpeechError,
  SpeechErrorKind,
  UtteranceHandle,
} from "../engine";
import { getEdgeVoices, type EdgeVoice } from "./voicesClient";

/** A minimal, always-silent WAV. Playing it once inside a user gesture is
 *  enough to mark this <audio> element as activated for the rest of the
 *  page's lifetime on iOS Safari, so a later programmatic play() (after an
 *  async fetch) is allowed even outside a gesture. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** How long we wait for the voice list before giving up and running with
 *  on-device voices only. */
const READY_TIMEOUT_MS = 5000;

interface RawTimedWord {
  charIndex: number;
  charLength: number;
  offsetMs: number;
  durationMs: number;
}

function toEngineVoice(voice: EdgeVoice): EngineVoice {
  // FriendlyNames read like "Microsoft Aria Online (Natural) - English
  // (United States)"; the picker already groups by language, so the
  // trailing " - <language> (<region>)" is dropped as redundant.
  const name = voice.FriendlyName.replace(/\s*-\s*[^-]+\([^)]+\)\s*$/, "").trim() || voice.FriendlyName;
  return {
    id: `edge:${voice.ShortName}`,
    name,
    lang: voice.Locale,
    local: false,
    isDefault: false,
    tier: "enhanced",
    quality: 0.85,
  };
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

interface SynthesisResult {
  words: RawTimedWord[];
  objectUrl: string;
}

class EdgeApiError extends Error {}

/** The actual network round trip: our proxy, then Microsoft's synthesis
 *  socket. Shared by `speak()` and `prefetch()` so a sentence fetched ahead
 *  of time and one fetched on demand go through the exact same path. */
async function requestSynthesis(
  text: string,
  voice: string,
  rate: number,
  signal: AbortSignal,
): Promise<SynthesisResult> {
  const response = await fetch("/api/speech/edge/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ text, voice, rate }),
  });
  if (!response.ok) {
    throw new EdgeApiError("The cloud voice service refused the request.");
  }
  const payload = (await response.json()) as { audio: string; words: RawTimedWord[] };
  const blob = base64ToBlob(payload.audio, "audio/mpeg");
  return { words: payload.words, objectUrl: URL.createObjectURL(blob) };
}

function edgeShortName(voiceId: string | null | undefined): string | null {
  return voiceId?.startsWith("edge:") ? voiceId.slice(5) : null;
}

function cacheKey(voice: string, text: string, rate: number): string {
  return `${voice} ${rate} ${text}`;
}

class EdgeUtterance implements UtteranceHandle {
  private cancelled = false;
  private finished = false;
  private readonly controller = new AbortController();
  private rafId: number | null = null;
  private words: RawTimedWord[] = [];
  private nextWordIndex = 0;
  private objectUrl: string | null = null;

  constructor(
    private readonly options: SpeakOptions,
    private readonly voiceShortName: string,
    private readonly callbacks: SpeakCallbacks,
    private readonly audio: HTMLAudioElement,
    /** Already in flight (or resolved) if the player prefetched this
     *  sentence while the previous one was still playing. */
    private readonly prefetched: Promise<SynthesisResult> | null,
  ) {}

  get done(): boolean {
    return this.finished || this.cancelled;
  }

  async start(): Promise<void> {
    try {
      // A prefetch that failed (aborted, or the request itself errored) falls
      // through to a fresh fetch rather than failing the sentence outright —
      // the lookahead is an optimization, not a dependency.
      const result = this.prefetched
        ? await this.prefetched.catch(() =>
            requestSynthesis(this.options.text, this.voiceShortName, this.options.rate, this.controller.signal),
          )
        : await requestSynthesis(this.options.text, this.voiceShortName, this.options.rate, this.controller.signal);

      if (this.cancelled) {
        URL.revokeObjectURL(result.objectUrl);
        return;
      }
      this.words = result.words;
      this.objectUrl = result.objectUrl;

      this.audio.onplay = () => {
        if (this.cancelled) return;
        this.callbacks.onStart?.();
        this.scheduleBoundaries();
      };
      this.audio.onended = () => this.finish();
      this.audio.onerror = () => {
        if (this.cancelled || this.finished) return;
        this.finished = true;
        this.stopBoundaries();
        this.callbacks.onError?.({
          kind: "synthesis-failed",
          message: "Playback of the cloud voice failed.",
        });
      };

      this.audio.src = this.objectUrl;
      await this.audio.play();
    } catch (error) {
      if (this.cancelled) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.fail("synthesis-failed", "The cloud voice service didn't respond.");
    }
  }

  private fail(kind: SpeechErrorKind, message: string): void {
    if (this.finished || this.cancelled) return;
    this.finished = true;
    const error: SpeechError = { kind, message };
    this.callbacks.onError?.(error);
  }

  private finish(): void {
    if (this.cancelled || this.finished) return;
    this.finished = true;
    this.stopBoundaries();
    this.callbacks.onEnd?.();
  }

  /** Walks the word list against audio.currentTime; boundary events have no
   *  native equivalent on an <audio> element, so this is the only clock. */
  private scheduleBoundaries(): void {
    this.nextWordIndex = 0;
    const tick = () => {
      if (this.cancelled || this.finished) return;
      const nowMs = this.audio.currentTime * 1000;
      while (this.nextWordIndex < this.words.length && this.words[this.nextWordIndex].offsetMs <= nowMs) {
        const word = this.words[this.nextWordIndex];
        const event: BoundaryEvent = {
          charIndex: word.charIndex,
          charLength: word.charLength,
          elapsed: nowMs,
        };
        this.callbacks.onBoundary?.(event);
        this.nextWordIndex += 1;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopBoundaries(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  pause(): void {
    if (this.cancelled || this.finished) return;
    try {
      this.audio.pause();
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    if (this.cancelled || this.finished) return;
    this.audio.play().catch(() => {
      /* the player's own resume-verify timer will notice and re-speak */
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    this.stopBoundaries();
    this.audio.onplay = null;
    this.audio.onended = null;
    this.audio.onerror = null;
    try {
      this.audio.pause();
    } catch {
      /* ignore */
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }
}

export interface EdgeSpeechEngineOptions {
  /** Filter like 'en-' passed to getEdgeVoices; keeps the list to one
   *  language rather than every locale Microsoft ships. */
  localePrefix?: string;
}

interface PendingPrefetch {
  key: string;
  controller: AbortController;
  promise: Promise<SynthesisResult>;
}

/**
 * Speaks through Microsoft Edge's cloud "Read Aloud" voices instead of
 * whatever is installed on the device. Synthesis happens on our own server
 * (see `/api/speech/edge/synthesize`) and comes back as one MP3 plus word
 * timings; this class just plays it and paces `onBoundary` against playback.
 */
export class EdgeSpeechEngine implements SpeechEngine {
  readonly id = "edge-tts";
  readonly providesWordTimings = true;

  private voices: EngineVoice[] = [];
  private readonly listeners = new Set<(voices: EngineVoice[]) => void>();
  private readyPromise: Promise<void> | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private current: EdgeUtterance | null = null;
  private pending: PendingPrefetch | null = null;

  constructor(private readonly options: EdgeSpeechEngineOptions = {}) {}

  get supported(): boolean {
    return typeof window !== "undefined" && typeof Audio !== "undefined" && typeof fetch !== "undefined";
  }

  ready(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.loadVoices();
    return this.readyPromise;
  }

  private async loadVoices(): Promise<void> {
    if (!this.supported) return;
    const timeout = new Promise<EdgeVoice[]>((resolve) =>
      setTimeout(() => resolve([]), READY_TIMEOUT_MS),
    );
    try {
      const voices = await Promise.race([getEdgeVoices(this.options.localePrefix), timeout]);
      this.voices = voices.map(toEngineVoice);
    } catch {
      // Cloud voices are a bonus; on-device voices carry the reader if this fails.
      this.voices = [];
    }
    const snapshot = this.voices;
    for (const listener of this.listeners) listener(snapshot);
  }

  listVoices(): EngineVoice[] {
    return this.voices;
  }

  subscribeVoices(listener: (voices: EngineVoice[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  unlock(): void {
    if (!this.supported || this.audioEl) return;
    const audio = new Audio(SILENT_WAV);
    audio.play().catch(() => {});
    this.audioEl = audio;
  }

  /**
   * Starts fetching a sentence's audio without playing it, so that by the
   * time the player actually asks to speak it (once the current sentence
   * ends), it's already downloaded. Without this, every sentence boundary
   * pays the full round trip to Microsoft as silence.
   */
  prefetch(options: SpeakOptions): void {
    const shortName = edgeShortName(options.voiceId);
    if (!this.supported || !shortName || !options.text.trim()) return;

    const key = cacheKey(shortName, options.text, options.rate);
    if (this.pending?.key === key) return;
    this.clearPending();

    const controller = new AbortController();
    const promise = requestSynthesis(options.text, shortName, options.rate, controller.signal);
    // A prefetch that fails just means speak() falls back to fetching it
    // itself later; nothing here is waiting on this promise directly.
    promise.catch(() => {});
    this.pending = { key, controller, promise };
  }

  private clearPending(): void {
    if (!this.pending) return;
    const stale = this.pending;
    this.pending = null;
    stale.controller.abort();
    stale.promise.then((result) => URL.revokeObjectURL(result.objectUrl)).catch(() => {});
  }

  speak(options: SpeakOptions, callbacks: SpeakCallbacks): UtteranceHandle {
    const shortName = edgeShortName(options.voiceId);
    if (!this.supported || !shortName) {
      const error: SpeechError = {
        kind: "no-voices",
        message: "No cloud voice is selected.",
      };
      queueMicrotask(() => callbacks.onError?.(error));
      return { cancel() {}, done: true };
    }
    if (!this.audioEl) this.unlock();

    let prefetched: Promise<SynthesisResult> | null = null;
    const key = cacheKey(shortName, options.text, options.rate);
    if (this.pending?.key === key) {
      prefetched = this.pending.promise;
      this.pending = null;
    }

    const utterance = new EdgeUtterance(options, shortName, callbacks, this.audioEl!, prefetched);
    this.current = utterance;
    void utterance.start();
    return utterance;
  }

  pause(): void {
    this.current?.pause();
  }

  resume(): void {
    this.current?.resume();
  }

  /**
   * The player calls this at the start of every sentence, including a normal
   * advance to the next one — not just on an actual seek or stop — so this
   * must leave a matching prefetch alone. A mismatched one is already
   * replaced (and revoked) the moment a new `prefetch()` call comes in, so
   * nothing here needs to preemptively guess whether this cancel means
   * "moving on" or "abandoning ship."
   */
  cancel(): void {
    this.current?.cancel();
    this.current = null;
  }

  isSpeaking(): boolean {
    return !!this.current && !this.current.done && !!this.audioEl && !this.audioEl.paused;
  }

  isPaused(): boolean {
    return !!this.current && !this.current.done && !!this.audioEl && this.audioEl.paused;
  }

  destroy(): void {
    this.cancel();
    this.clearPending();
    this.listeners.clear();
    this.audioEl = null;
  }
}
