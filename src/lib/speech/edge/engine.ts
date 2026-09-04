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
  ) {}

  get done(): boolean {
    return this.finished || this.cancelled;
  }

  async start(): Promise<void> {
    try {
      const response = await fetch("/api/speech/edge/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: this.controller.signal,
        body: JSON.stringify({
          text: this.options.text,
          voice: this.voiceShortName,
          rate: this.options.rate,
        }),
      });
      if (this.cancelled) return;
      if (!response.ok) {
        this.fail("synthesis-failed", "The cloud voice service refused the request.");
        return;
      }

      const payload = (await response.json()) as { audio: string; words: RawTimedWord[] };
      if (this.cancelled) return;
      this.words = payload.words;

      const blob = base64ToBlob(payload.audio, "audio/mpeg");
      this.objectUrl = URL.createObjectURL(blob);

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

  speak(options: SpeakOptions, callbacks: SpeakCallbacks): UtteranceHandle {
    const shortName = options.voiceId?.startsWith("edge:") ? options.voiceId.slice(5) : null;
    if (!this.supported || !shortName) {
      const error: SpeechError = {
        kind: "no-voices",
        message: "No cloud voice is selected.",
      };
      queueMicrotask(() => callbacks.onError?.(error));
      return { cancel() {}, done: true };
    }
    if (!this.audioEl) this.unlock();

    const utterance = new EdgeUtterance(options, shortName, callbacks, this.audioEl!);
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
    this.listeners.clear();
    this.audioEl = null;
  }
}
