import type {
  BoundaryEvent,
  EngineVoice,
  SpeakCallbacks,
  SpeakOptions,
  SpeechEngine,
  SpeechError,
  UtteranceHandle,
  VoiceTier,
} from "./engine";

/** Apple ships a pile of joke voices that must never outrank a real one. */
const NOVELTY = new Set(
  [
    "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos",
    "deranged", "good news", "jester", "junior", "kathy", "organ", "princess",
    "ralph", "superstar", "trinoids", "whisper", "wobble", "zarvox", "grandma",
    "grandpa", "rocko", "shelley", "sandy", "flo", "eddy", "reed",
  ].map((n) => n.toLowerCase()),
);

/**
 * Apple puts the quality tier in the voiceURI, not the name — a Premium voice
 * and one of the robotic Eloquence voices can both be called "Reed". Reading
 * the URI is the only reliable way to tell them apart, and getting this wrong
 * is why a phone full of downloaded Premium voices still offers junk first.
 */
export function classifyVoice(v: Pick<SpeechSynthesisVoice, "voiceURI" | "name">): VoiceTier {
  const uri = (v.voiceURI || "").toLowerCase();
  const name = v.name.toLowerCase();

  // Eloquence is the 1980s-sounding synthesiser iOS ships dozens of.
  if (uri.startsWith("com.apple.eloquence.")) return "novelty";
  // The old macOS joke voices.
  if (uri.startsWith("com.apple.speech.synthesis.voice.")) {
    const bare = name.replace(/\s*\(.*\)\s*/g, "").trim();
    return NOVELTY.has(bare) ? "novelty" : "compact";
  }
  // Siri's own voices are reserved for the system; they are listed on some
  // versions but cannot actually be used by a web page.
  if (uri.includes("ttsbundle.siri") || /^siri/.test(name)) return "siri";

  if (uri.includes(".premium.") || /premium/.test(name)) return "premium";
  if (uri.includes(".enhanced.") || /enhanced|neural|natural/.test(name)) return "enhanced";
  if (uri.includes(".compact.")) return "compact";

  // Only trust the name once the URI has told us nothing: the novelty list
  // collides with real people's names, and a Premium "Reed" is not a joke
  // voice merely because an Eloquence one shares its name.
  if (NOVELTY.has(name.replace(/\s*\(.*\)\s*/g, "").trim())) return "novelty";
  return "standard";
}

const TIER_SCORE: Record<VoiceTier, number> = {
  premium: 1,
  enhanced: 0.85,
  standard: 0.6,
  compact: 0.35,
  siri: 0.1,
  novelty: 0.02,
};

function scoreVoice(v: SpeechSynthesisVoice, tier: VoiceTier): number {
  let score = TIER_SCORE[tier];
  // Chrome's Google voices and Edge's online naturals are a cut above the
  // generic "standard" bucket they otherwise land in.
  if (tier === "standard") {
    if (/^google/.test(v.name.toLowerCase())) score += 0.15;
    if (/online \(natural\)/.test(v.name.toLowerCase())) score += 0.2;
  }
  if (v.localService && tier !== "novelty") score += 0.03;
  return Math.max(0, Math.min(1, score));
}

function voiceId(v: SpeechSynthesisVoice): string {
  return v.voiceURI || `${v.name}|${v.lang}`;
}

/** Strip Apple's parenthetical suffixes so the tier badge carries that job. */
function displayName(v: SpeechSynthesisVoice, tier: VoiceTier): string {
  if (tier === "premium" || tier === "enhanced") {
    return v.name.replace(/\s*\((?:premium|enhanced)\)\s*$/i, "").trim() || v.name;
  }
  return v.name;
}

function toEngineVoice(v: SpeechSynthesisVoice): EngineVoice {
  const tier = classifyVoice(v);
  return {
    id: voiceId(v),
    name: displayName(v, tier),
    lang: v.lang,
    local: v.localService,
    isDefault: v.default,
    tier,
    quality: scoreVoice(v, tier),
  };
}

function classifyError(event: SpeechSynthesisErrorEvent): SpeechError {
  switch (event.error) {
    case "not-allowed":
      return {
        kind: "not-allowed",
        message: "This browser blocked speech until you interact with the page.",
      };
    case "canceled":
    case "interrupted":
      return { kind: "interrupted", message: "Playback was interrupted." };
    case "synthesis-failed":
    case "synthesis-unavailable":
    case "audio-busy":
    case "audio-hardware":
      return { kind: "synthesis-failed", message: "The voice stopped responding." };
    default:
      return { kind: "unknown", message: `Speech error: ${event.error}` };
  }
}

/** How long the browser's own resume() keepalive tick waits. Chrome silently
 *  stops synthesising after roughly 15 seconds without one. */
const KEEPALIVE_MS = 8000;

export class WebSpeechEngine implements SpeechEngine {
  readonly id = "web-speech";
  readonly providesWordTimings = false;

  private voices: SpeechSynthesisVoice[] = [];
  private listeners = new Set<(voices: EngineVoice[]) => void>();
  private readyPromise: Promise<void> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private intentPaused = false;
  private unlocked = false;
  private current: WebUtterance | null = null;
  private onVoicesChanged = () => this.refreshVoices();

  get supported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  ready(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.waitForVoices();
    return this.readyPromise;
  }

  /** getVoices() is async on every engine that matters and outright empty on
   *  first call in Safari, so poll alongside the event and stop early. */
  private waitForVoices(): Promise<void> {
    if (!this.supported) return Promise.resolve();
    window.speechSynthesis.addEventListener("voiceschanged", this.onVoicesChanged);
    this.refreshVoices();
    if (this.voices.length) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const started = Date.now();
      const tick = () => {
        this.refreshVoices();
        if (this.voices.length || Date.now() - started > 4000) {
          resolve();
          return;
        }
        setTimeout(tick, 150);
      };
      setTimeout(tick, 100);
    });
  }

  private refreshVoices(): void {
    if (!this.supported) return;
    const next = window.speechSynthesis.getVoices();
    if (next.length === this.voices.length && next.every((v, i) => this.voices[i] === v)) {
      return;
    }
    this.voices = next;
    const engineVoices = this.listVoices();
    for (const listener of this.listeners) listener(engineVoices);
  }

  listVoices(): EngineVoice[] {
    return this.voices.map(toEngineVoice);
  }

  subscribeVoices(listener: (voices: EngineVoice[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * iOS requires the first speak() to happen inside a user gesture, which it
   * always does here: play and tap-a-word both call the player synchronously.
   *
   * This deliberately does not queue a silent primer utterance. Doing so put a
   * pending utterance in the queue that the very next call immediately
   * cancelled, and cancel() followed by speak() in the same tick is one of the
   * reliable ways to get silence out of Safari.
   */
  unlock(): void {
    this.unlocked = true;
  }

  private resolveVoice(id: string | null): SpeechSynthesisVoice | null {
    if (!id) return null;
    return this.voices.find((v) => voiceId(v) === id) ?? null;
  }

  speak(options: SpeakOptions, callbacks: SpeakCallbacks): UtteranceHandle {
    if (!this.supported) {
      const error: SpeechError = {
        kind: "no-voices",
        message: "This browser has no speech synthesis.",
      };
      queueMicrotask(() => callbacks.onError?.(error));
      return { cancel() {}, done: true };
    }
    this.intentPaused = false;
    const utterance = new WebUtterance(options, callbacks, this.resolveVoice(options.voiceId));
    this.current = utterance;
    this.startKeepalive();
    utterance.start();
    return utterance;
  }

  private startKeepalive(): void {
    if (this.keepalive) return;
    this.keepalive = setInterval(() => {
      if (!this.supported) return;
      const synth = window.speechSynthesis;
      if (!synth.speaking) return;
      if (this.intentPaused) return;
      // A no-op when nothing is paused, and the documented workaround for
      // Chrome's ~15s cutoff when something is.
      synth.resume();
    }, KEEPALIVE_MS);
  }

  pause(): void {
    if (!this.supported) return;
    this.intentPaused = true;
    try {
      window.speechSynthesis.pause();
    } catch {
      /* Safari throws on pause() in some versions; the player falls back. */
    }
  }

  resume(): void {
    if (!this.supported) return;
    this.intentPaused = false;
    try {
      window.speechSynthesis.resume();
    } catch {
      /* the player detects the failure and re-speaks instead */
    }
  }

  cancel(): void {
    this.current?.cancel();
    this.current = null;
    this.intentPaused = false;
    if (!this.supported) return;
    const synth = window.speechSynthesis;
    // Only interrupt something that is actually running. Calling cancel() on an
    // idle synthesiser and then speaking immediately after can leave Safari
    // reporting speaking === true while producing no audio at all.
    if (!synth.speaking && !synth.pending && !synth.paused) return;
    try {
      synth.cancel();
    } catch {
      /* ignore */
    }
  }

  isSpeaking(): boolean {
    return this.supported && window.speechSynthesis.speaking;
  }

  isPaused(): boolean {
    return this.supported && window.speechSynthesis.paused;
  }

  destroy(): void {
    this.cancel();
    this.listeners.clear();
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    if (this.supported) {
      window.speechSynthesis.removeEventListener("voiceschanged", this.onVoicesChanged);
    }
  }
}

class WebUtterance implements UtteranceHandle {
  private utterance: SpeechSynthesisUtterance;
  private cancelled = false;
  private finished = false;
  private startedAt = 0;

  constructor(
    options: SpeakOptions,
    private callbacks: SpeakCallbacks,
    voice: SpeechSynthesisVoice | null,
  ) {
    const u = new SpeechSynthesisUtterance(options.text);
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.rate = options.rate;
    u.pitch = options.pitch ?? 1;
    u.volume = options.volume ?? 1;

    u.onstart = () => {
      this.startedAt = performance.now();
      if (this.cancelled) return;
      this.callbacks.onStart?.();
    };
    u.onboundary = (event) => {
      if (this.cancelled || this.finished) return;
      // Safari reports word boundaries with charLength omitted or zero.
      if (event.name && event.name !== "word") return;
      const boundary: BoundaryEvent = {
        charIndex: event.charIndex ?? 0,
        charLength: event.charLength || 0,
        elapsed: this.startedAt ? performance.now() - this.startedAt : 0,
      };
      this.callbacks.onBoundary?.(boundary);
    };
    u.onend = () => {
      if (this.cancelled || this.finished) return;
      this.finished = true;
      this.callbacks.onEnd?.();
    };
    u.onerror = (event) => {
      if (this.cancelled || this.finished) return;
      this.finished = true;
      const error = classifyError(event);
      if (error.kind === "interrupted") return;
      this.callbacks.onError?.(error);
    };

    this.utterance = u;
  }

  start(): void {
    // Guard against a stuck queue from a previous cancel that Safari didn't
    // fully flush; speaking on top of a paused synth produces silence.
    const synth = window.speechSynthesis;
    if (synth.paused) synth.resume();
    synth.speak(this.utterance);
  }

  get done(): boolean {
    return this.finished || this.cancelled;
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.utterance.onstart = null;
    this.utterance.onboundary = null;
    this.utterance.onend = null;
    this.utterance.onerror = null;
  }
}

let singleton: WebSpeechEngine | null = null;

export function getSpeechEngine(): WebSpeechEngine {
  if (!singleton) singleton = new WebSpeechEngine();
  return singleton;
}
