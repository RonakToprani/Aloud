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

/**
 * ShortNames are structured — "en-US-AriaNeural", "en-US-AvaMultilingualNeural"
 * — so they make a far cleaner label than the FriendlyName, which repeats
 * "Microsoft … Online (Natural)" on every row and wraps to two lines in the
 * picker. The vendor and the technology are not what anyone is choosing
 * between; the voice is.
 */
function displayName(voice: EdgeVoice): string {
  const bare = (voice.ShortName.split("-").pop() ?? "").replace(/Neural$/, "");
  if (!bare) {
    return voice.FriendlyName.replace(/\s*-\s*[^-]+\([^)]+\)\s*$/, "").trim() || voice.FriendlyName;
  }
  // "AvaMultilingual" -> "Ava Multilingual"
  return bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

function toEngineVoice(voice: EdgeVoice): EngineVoice {
  const name = displayName(voice);
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

/** How long to wait for an element to buffer before playing it anyway. */
const PRIME_TIMEOUT_MS = 4000;
/** HTMLMediaElement.HAVE_CURRENT_DATA */
const HAVE_CURRENT_DATA = 2;

/**
 * One sentence, decoded into an <audio> element and ready to play.
 *
 * Downloading a sentence early is only half the job: assigning `src` and
 * playing costs a load and a decode, and doing that at the sentence boundary
 * is what turned the round trip into an audible gap. A primed track has
 * already paid both, so starting it is just play().
 */
interface PrimedTrack {
  key: string;
  el: HTMLAudioElement;
  objectUrl: string;
  words: RawTimedWord[];
  /** Resolves once the element can play without stalling. */
  ready: Promise<void>;
}

function primeElement(el: HTMLAudioElement, key: string, result: SynthesisResult): PrimedTrack {
  el.src = result.objectUrl;
  el.load();

  const ready = new Promise<void>((resolve) => {
    if (el.readyState >= HAVE_CURRENT_DATA) {
      resolve();
      return;
    }
    const done = () => {
      el.removeEventListener("canplaythrough", done);
      el.removeEventListener("loadeddata", done);
      clearTimeout(timer);
      resolve();
    };
    // The blob is already local, so this normally settles on the first tick;
    // the timeout only covers a decode that never reports readiness.
    const timer = setTimeout(done, PRIME_TIMEOUT_MS);
    el.addEventListener("canplaythrough", done, { once: true });
    el.addEventListener("loadeddata", done, { once: true });
  });

  return { key, el, objectUrl: result.objectUrl, words: result.words, ready };
}

function discardTrack(track: PrimedTrack): void {
  try {
    track.el.pause();
    track.el.removeAttribute("src");
    track.el.load();
  } catch {
    /* the element is being torn down anyway */
  }
  URL.revokeObjectURL(track.objectUrl);
}

class EdgeUtterance implements UtteranceHandle {
  private cancelled = false;
  private finished = false;
  private readonly controller = new AbortController();
  private rafId: number | null = null;
  private words: RawTimedWord[] = [];
  private nextWordIndex = 0;
  private track: PrimedTrack | null = null;

  constructor(
    private readonly callbacks: SpeakCallbacks,
    /** Hands back a track that is already decoded, fetching one if needed. */
    private readonly acquire: (signal: AbortSignal) => Promise<PrimedTrack>,
    private readonly release: (el: HTMLAudioElement) => void,
  ) {}

  get done(): boolean {
    return this.finished || this.cancelled;
  }

  async start(): Promise<void> {
    try {
      const track = await this.acquire(this.controller.signal);
      if (this.cancelled) {
        discardTrack(track);
        return;
      }
      this.track = track;
      this.words = track.words;
      const el = track.el;

      el.onplay = () => {
        if (this.cancelled) return;
        this.callbacks.onStart?.();
        this.scheduleBoundaries();
      };
      el.onended = () => this.finish();
      el.onerror = () => {
        if (this.cancelled || this.finished) return;
        this.finished = true;
        this.stopBoundaries();
        this.callbacks.onError?.({
          kind: "synthesis-failed",
          message: "Playback of the cloud voice failed.",
        });
      };

      await track.ready;
      if (this.cancelled) return;
      await el.play();
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
    // Free the element straight away so the sentence after next can be primed
    // onto it while the next one plays.
    if (this.track) this.release(this.track.el);
    this.callbacks.onEnd?.();
  }

  /** Walks the word list against currentTime; boundary events have no native
   *  equivalent on an <audio> element, so this is the only clock. */
  private scheduleBoundaries(): void {
    this.nextWordIndex = 0;
    const tick = () => {
      if (this.cancelled || this.finished || !this.track) return;
      const nowMs = this.track.el.currentTime * 1000;
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

  get element(): HTMLAudioElement | null {
    return this.track?.el ?? null;
  }

  pause(): void {
    if (this.cancelled || this.finished) return;
    try {
      this.track?.el.pause();
    } catch {
      /* ignore */
    }
  }

  resume(): void {
    if (this.cancelled || this.finished) return;
    this.track?.el.play().catch(() => {
      /* the player's own resume-verify timer will notice and re-speak */
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    this.stopBoundaries();
    if (this.track) {
      const el = this.track.el;
      el.onplay = null;
      el.onended = null;
      el.onerror = null;
      discardTrack(this.track);
      this.release(el);
      this.track = null;
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
  /** Two elements: one plays while the next sentence decodes onto the other. */
  private pool: HTMLAudioElement[] = [];
  private busy: HTMLAudioElement | null = null;
  private primed: PrimedTrack | null = null;
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
    if (!this.supported || this.pool.length) return;
    // Both elements have to be activated inside the gesture; an element that
    // never played during a user interaction cannot be started programmatically
    // later on iOS, and the whole point of the second one is that it starts
    // without one.
    this.pool = [new Audio(SILENT_WAV), new Audio(SILENT_WAV)];
    for (const el of this.pool) {
      el.preload = "auto";
      el.play().catch(() => {});
    }
  }

  private idleElement(): HTMLAudioElement {
    if (!this.pool.length) this.unlock();
    return this.pool.find((el) => el !== this.busy) ?? this.pool[0];
  }

  private releasePrimed(): void {
    if (!this.primed) return;
    discardTrack(this.primed);
    this.primed = null;
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
    this.pending = { key, controller, promise };

    // Decoding is the half that actually costs time at the boundary, so the
    // audio is loaded into the spare element as soon as the bytes land rather
    // than being left as a blob for speak() to mount later.
    promise
      .then((result) => {
        if (this.pending?.key !== key) {
          URL.revokeObjectURL(result.objectUrl);
          return;
        }
        this.pending = null;
        this.releasePrimed();
        this.primed = primeElement(this.idleElement(), key, result);
      })
      .catch(() => {
        // A failed prefetch just means speak() fetches it itself.
        if (this.pending?.key === key) this.pending = null;
      });
  }

  private clearPending(): void {
    if (!this.pending) return;
    const stale = this.pending;
    this.pending = null;
    stale.controller.abort();
    stale.promise.then((result) => URL.revokeObjectURL(result.objectUrl)).catch(() => {});
  }

  /** Whether the sentence about to be spoken is already decoded and waiting. */
  private hasPrimed(key: string): boolean {
    return this.primed?.key === key;
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
    if (!this.pool.length) this.unlock();

    const key = cacheKey(shortName, options.text, options.rate);

    const acquire = async (signal: AbortSignal): Promise<PrimedTrack> => {
      // The fast path: the sentence was primed while the previous one played,
      // so there is nothing left to download, mount or decode.
      if (this.hasPrimed(key)) {
        const track = this.primed!;
        this.primed = null;
        this.busy = track.el;
        return track;
      }

      // Otherwise take an in-flight prefetch if it matches, or fetch now.
      let result: SynthesisResult;
      if (this.pending?.key === key) {
        const inFlight = this.pending;
        this.pending = null;
        result = await inFlight.promise;
      } else {
        result = await requestSynthesis(options.text, shortName, options.rate, signal);
      }
      const el = this.idleElement();
      this.busy = el;
      return primeElement(el, key, result);
    };

    const utterance = new EdgeUtterance(callbacks, acquire, (el) => {
      if (this.busy === el) this.busy = null;
    });
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
    const el = this.current?.element;
    return !!this.current && !this.current.done && !!el && !el.paused;
  }

  isPaused(): boolean {
    const el = this.current?.element;
    return !!this.current && !this.current.done && !!el && el.paused;
  }

  destroy(): void {
    this.cancel();
    this.clearPending();
    this.releasePrimed();
    this.listeners.clear();
    this.pool = [];
    this.busy = null;
  }
}
