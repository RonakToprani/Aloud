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
import { planPassage, type PassageInput, type PassagePlan } from "./passage";
import {
  applyCuts,
  DEFAULT_TIGHTEN,
  planCuts,
  remapWords,
  type SentenceSpan,
  type TightenSettings,
} from "./tighten";

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

/** Voices Microsoft tags for long-form narration. In a reading app these are
 *  the ones actually worth reaching for, so they also rank above the
 *  conversational voices rather than merely being labelled. */
const NARRATION_TRAITS = new Set(["novel", "audiobook", "narration"]);

function isNarrationVoice(traits: string[]): boolean {
  return traits.some((trait) => NARRATION_TRAITS.has(trait.toLowerCase()));
}

function toEngineVoice(voice: EdgeVoice): EngineVoice {
  const name = displayName(voice);
  const traits = voice.VoiceTag?.ContentCategories ?? [];
  return {
    traits,
    id: `edge:${voice.ShortName}`,
    name,
    lang: voice.Locale,
    local: false,
    isDefault: false,
    tier: "enhanced",
    quality: isNarrationVoice(traits) ? 0.95 : 0.85,
  };
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

interface SynthesisResult {
  words: RawTimedWord[];
  /** Raw MP3; decoding happens once, ahead of time, into an AudioBuffer. */
  bytes: ArrayBuffer;
}

/** A sentence decoded and able to start on the next audio tick. */
interface DecodedSentence {
  buffer: AudioBuffer;
  words: RawTimedWord[];
}

/** How many decoded sentences to keep for a skip backwards. */
const DECODED_CACHE_LIMIT = 8;

/** How much text each successive passage asks for. The first is small so
 *  pressing play feels immediate; the second is synthesised while the first
 *  plays and so can be larger; from then on there is a passage of margin. */
const PASSAGE_BUDGETS = [220, 700, 1500];

/** Sentence and paragraph watchers poll the audio clock this often. A timer
 *  rather than requestAnimationFrame, which stops entirely while the tab is
 *  in the background and would leave a passage's end undetected. */
const WATCH_INTERVAL_MS = 40;

/**
 * Trim the silences Edge leaves in a clip — see tighten.ts. Returns a new
 * buffer and the word timings shifted to match.
 */
function tightenBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  words: RawTimedWord[],
  sentences: SentenceSpan[],
  settings: TightenSettings = DEFAULT_TIGHTEN,
): { buffer: AudioBuffer; words: RawTimedWord[] } {
  const channel = buffer.getChannelData(0);
  const cuts = planCuts(channel, buffer.sampleRate, words, sentences, settings);
  if (!cuts.length) return { buffer, words };
  const first = applyCuts(channel, buffer.sampleRate, cuts);
  if (!first.length) return { buffer, words };
  const out = ctx.createBuffer(buffer.numberOfChannels, first.length, buffer.sampleRate);
  out.copyToChannel(first, 0);
  for (let c = 1; c < buffer.numberOfChannels; c++) {
    out.copyToChannel(applyCuts(buffer.getChannelData(c), buffer.sampleRate, cuts), c);
  }
  return { buffer: out, words: remapWords(words, cuts) };
}

/** A lone sentence keeps a sentence's worth of pause at its end, since the
 *  next clip only starts once this one reports finishing. */
const LONE_SENTENCE_TIGHTEN: TightenSettings = {
  ...DEFAULT_TIGHTEN,
  trailMs: DEFAULT_TIGHTEN.sentencePauseMs,
};

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
  return { words: payload.words, bytes: base64ToBytes(payload.audio) };
}

function edgeShortName(voiceId: string | null | undefined): string | null {
  return voiceId?.startsWith("edge:") ? voiceId.slice(5) : null;
}

function cacheKey(voice: string, text: string, rate: number): string {
  return `${voice} ${rate} ${text}`;
}

/** Silence long enough to loop, used only to hold the audio session open. */
function silentWavUrl(seconds = 2): string {
  const rate = 8000;
  const frames = rate * seconds;
  const size = 44 + frames;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, size - 8, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, frames, true);
  new Uint8Array(buffer, 44).fill(128); // 8-bit silence sits at the midpoint
  return URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
}

/**
 * Where cloud audio comes out.
 *
 * Playback moved off <audio> elements because iOS Safari ignores `preload`: an
 * element does not fetch or decode until play() is called, so priming one
 * ahead of time — which measured beautifully in desktop Chrome — bought
 * nothing at all on an iPhone, and every sentence still paid its decode at the
 * boundary. decodeAudioData does the decode when asked, into memory, and a
 * buffer source then starts on the next audio tick.
 *
 * A silent looping element runs alongside purely to hold the media session, so
 * lock-screen controls and background playback keep working.
 */
class CloudAudioOutput {
  private ctx: AudioContext | null = null;
  private sessionHolder: HTMLAudioElement | null = null;
  private silenceUrl: string | null = null;
  /** When available, the graph feeds the element instead of the speakers
   *  directly, so iOS sees ordinary media playback. */
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  /** Keeps the stream fed between sentences — see startSilentFeed. */
  private silentFeed: AudioBufferSourceNode | null = null;
  private readonly onVisible = () => {
    if (document.visibilityState === "visible") void this.resumeContext();
  };

  constructor() {
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisible);
    }
  }

  get context(): AudioContext | null {
    return this.ensureContext();
  }

  /** Creating a context needs no gesture, and decodeAudioData works while it
   *  is still suspended — which is what lets a sentence be decoded before the
   *  reader has pressed play. */
  private ensureContext(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === "undefined") return null;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    return this.ctx;
  }

  /**
   * Where buffer sources should connect.
   *
   * Routing through a MediaStreamAudioDestinationNode attached to an <audio>
   * element makes the element the thing iOS sees playing, which is the only
   * kind of playback it allows to continue once the screen locks. A bare
   * AudioContext is suspended on lock, which is why locking stopped playback
   * and why the notification's play button had nothing it could restart.
   */
  get destination(): AudioNode | null {
    const ctx = this.ensureContext();
    if (!ctx) return null;
    return this.streamDest ?? ctx.destination;
  }

  /** Must run inside a user gesture. */
  activate(): void {
    const ctx = this.ensureContext();
    void ctx?.resume().catch(() => {});

    if (!this.sessionHolder && ctx) {
      const el = new Audio();
      el.loop = true;
      const canStream =
        typeof MediaStream !== "undefined" &&
        "srcObject" in HTMLMediaElement.prototype &&
        typeof ctx.createMediaStreamDestination === "function";

      if (canStream) {
        try {
          this.streamDest = ctx.createMediaStreamDestination();
          el.srcObject = this.streamDest.stream;
        } catch {
          this.streamDest = null;
        }
      }
      if (this.streamDest) {
        // A MediaStream element is live: `loop` means nothing to it, and the
        // stream must never be allowed to run dry.
        el.loop = false;
        this.startSilentFeed(ctx, this.streamDest);
      } else {
        // Fall back to silence that merely holds the session; the graph then
        // plays out of the context directly.
        this.silenceUrl = silentWavUrl();
        el.src = this.silenceUrl;
      }
      this.sessionHolder = el;
    }
    void this.sessionHolder?.play().catch(() => {});
  }

  /**
   * Holds the audio session for as long as a book is open — including while
   * paused. Letting the silent element stop tears down the iOS now-playing
   * entry, and its play button then has nothing left to talk to, which looks
   * from the lock screen exactly like playback refusing to start.
   * Paused-ness is communicated through mediaSession.playbackState instead.
   */
  keepSessionAlive(): void {
    if (!this.sessionHolder) return;
    void this.sessionHolder.play().catch(() => {});
  }

  /**
   * A MediaStream that stops receiving samples does not fall silent — the
   * pipeline holds or repeats whatever it had last, which is heard as the end
   * of the last word stuttering after a pause. Feeding it a looping buffer of
   * silence for the life of the context keeps it running dry-free.
   */
  private startSilentFeed(ctx: AudioContext, dest: AudioNode): void {
    if (this.silentFeed) return;
    try {
      const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.5), ctx.sampleRate);
      const feed = ctx.createBufferSource();
      feed.buffer = buffer; // already all zeroes
      feed.loop = true;
      feed.connect(dest);
      feed.start();
      this.silentFeed = feed;
    } catch {
      /* without it the stutter returns, but playback still works */
    }
  }

  /** iOS suspends the context whenever the page loses focus, and a suspended
   *  context schedules sources that never make a sound. */
  async resumeContext(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx && ctx.state !== "running") await ctx.resume().catch(() => {});
  }

  async decode(bytes: ArrayBuffer): Promise<AudioBuffer> {
    const ctx = this.ensureContext();
    if (!ctx) throw new Error("This browser has no Web Audio support.");
    return ctx.decodeAudioData(bytes);
  }

  shutdown(): void {
    try {
      this.silentFeed?.stop();
    } catch {
      /* already stopped */
    }
    this.silentFeed?.disconnect();
    this.silentFeed = null;
    this.streamDest?.disconnect();
    this.streamDest = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisible);
    }
    this.sessionHolder?.pause();
    this.sessionHolder = null;
    if (this.silenceUrl) URL.revokeObjectURL(this.silenceUrl);
    this.silenceUrl = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

class EdgeUtterance implements UtteranceHandle {
  private cancelled = false;
  private finished = false;
  private readonly controller = new AbortController();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private words: RawTimedWord[] = [];
  private nextWordIndex = 0;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Context time that the buffer's zero offset corresponds to. */
  private originTime = 0;
  private pausedAt: number | null = null;

  constructor(
    private readonly callbacks: SpeakCallbacks,
    private readonly output: CloudAudioOutput,
    private readonly acquire: (signal: AbortSignal) => Promise<DecodedSentence>,
  ) {}

  get done(): boolean {
    return this.finished || this.cancelled;
  }

  get playing(): boolean {
    if (!this.source || this.pausedAt !== null || this.done) return false;
    // A source attached to a suspended context is not playing, however much
    // it looks like it is; reporting otherwise hides the failure from the
    // player's own recovery path.
    return this.output.context?.state === "running";
  }

  get paused(): boolean {
    return this.pausedAt !== null && !this.done;
  }

  async start(): Promise<void> {
    try {
      const sentence = await this.acquire(this.controller.signal);
      if (this.cancelled) return;
      this.buffer = sentence.buffer;
      this.words = sentence.words;

      const ctx = this.output.context;
      if (!ctx) {
        this.fail("synthesis-failed", "This browser can't play cloud audio.");
        return;
      }
      // Resumed here as well as on activate: iOS suspends the context whenever
      // the page loses focus, and a suspended context plays nothing.
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      if (this.cancelled) return;

      this.playFrom(0);
      this.output.keepSessionAlive();
      this.callbacks.onStart?.();
      this.scheduleBoundaries();
    } catch (error) {
      if (this.cancelled) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.fail("synthesis-failed", "The cloud voice service didn't respond.");
    }
  }

  private playFrom(offsetSeconds: number): void {
    const ctx = this.output.context;
    if (!ctx || !this.buffer) return;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    // A gain stage purely so playback can be cut without a click: stopping a
    // buffer source mid-waveform is a step discontinuity, and it is audible.
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1, ctx.currentTime);
    source.connect(gain);
    gain.connect(this.output.destination ?? ctx.destination);
    source.onended = () => this.finish();
    source.start(0, offsetSeconds);
    this.source = source;
    this.gain = gain;
    this.originTime = ctx.currentTime - offsetSeconds;
    this.pausedAt = null;
  }

  private static readonly FADE_SECONDS = 0.025;

  private stopSource(): void {
    const source = this.source;
    const gain = this.gain;
    if (!source) return;
    this.source = null;
    this.gain = null;
    // Detach the handler before stopping rather than guarding it with a flag:
    // 'ended' is delivered asynchronously, so any flag set around stop() is
    // already back to its old value by the time the event arrives. That made
    // every pause look like a sentence finishing naturally, and the player
    // dutifully advanced and carried on playing.
    source.onended = null;

    const ctx = this.output.context;
    const fade = EdgeUtterance.FADE_SECONDS;
    try {
      if (ctx && gain) {
        const now = ctx.currentTime;
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fade);
        source.stop(now + fade + 0.01);
      } else {
        source.stop();
      }
    } catch {
      /* already stopped */
    }
    // Disconnect only once the fade has actually played out.
    const cleanup = () => {
      try {
        source.disconnect();
        gain?.disconnect();
      } catch {
        /* already detached */
      }
    };
    if (ctx && gain) setTimeout(cleanup, (fade + 0.05) * 1000);
    else cleanup();
  }

  /** Seconds into the sentence. */
  private elapsed(): number {
    if (this.pausedAt !== null) return this.pausedAt;
    const ctx = this.output.context;
    if (!ctx) return 0;
    return Math.max(0, ctx.currentTime - this.originTime);
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

  /** Walks the word list against the audio clock; there is no native boundary
   *  event, so this is the only timing source. */
  private scheduleBoundaries(): void {
    this.nextWordIndex = 0;
    const tick = () => {
      if (this.cancelled || this.finished) {
        this.stopBoundaries();
        return;
      }
      const nowMs = this.elapsed() * 1000;
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
    };
    this.stopBoundaries();
    this.ticker = setInterval(tick, WATCH_INTERVAL_MS);
  }

  private stopBoundaries(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  pause(): void {
    if (this.cancelled || this.finished || this.pausedAt !== null) return;
    // A buffer source cannot be paused, so remember the offset and stop it;
    // resume starts a fresh source from there.
    const at = this.elapsed();
    this.stopSource();
    this.pausedAt = at;
    // The session holder deliberately keeps running here.
  }

  resume(): void {
    if (this.cancelled || this.finished || this.pausedAt === null) return;
    const offset = this.pausedAt;
    this.output.keepSessionAlive();
    void this.output.resumeContext().then(() => {
      if (this.cancelled || this.finished || this.pausedAt === null) return;
      this.playFrom(offset);
    });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.controller.abort();
    this.stopBoundaries();
    this.stopSource();
  }
}

/** A synthesised passage, with each sentence located in time. */
interface DecodedPassage {
  key: string;
  plan: PassagePlan;
  buffer: AudioBuffer;
  words: RawTimedWord[];
  startMs: number[];
  /** A sentence's span ends where the next begins; the last one's ends a
   *  pause after the audio does, which is when the next passage is due. */
  endMs: number[];
  /** Silence owed after the last word, before whatever follows. */
  pauseAfterMs: number;
}

/** Locate each sentence in the tightened audio using the word timings, whose
 *  char indices address the passage as a whole. */
function locateSentences(
  plan: PassagePlan,
  words: RawTimedWord[],
  durationMs: number,
  pauseAfterMs: number,
): { startMs: number[]; endMs: number[] } {
  const startMs = plan.sentences.map((sentence) => {
    const first = words.find((word) => word.charIndex >= sentence.start);
    return first ? first.offsetMs : 0;
  });
  // A sentence runs until the next one opens, so no audio is ever skipped —
  // trailing pauses belong to the sentence that caused them.
  const endMs = startMs.map((_, i) =>
    i + 1 < startMs.length ? startMs[i + 1] : durationMs + pauseAfterMs,
  );
  return { startMs, endMs };
}

function pauseAfter(plan: PassagePlan): number {
  const last = plan.sentences[plan.sentences.length - 1];
  return last?.endsParagraph ? DEFAULT_TIGHTEN.paragraphPauseMs : DEFAULT_TIGHTEN.sentencePauseMs;
}

interface PlaybackHooks {
  /** Audio was (re)scheduled: anything queued behind it must be re-timed. */
  onStarted(playback: PassagePlayback): void;
  /** Audio was stopped or paused: anything queued behind it is void. */
  onStopped(playback: PassagePlayback): void;
}

/**
 * Plays one passage from end to end.
 *
 * The audio keeps running across sentence boundaries; a sentence ending is a
 * timestamp being crossed, not a source stopping. That is what makes the
 * intonation carry from one sentence into the next. A passage can also be
 * scheduled to begin at an exact moment on the audio clock — the end of the
 * one before it — so the seam between passages is sample-accurate rather
 * than whenever JavaScript next gets a turn.
 */
class PassagePlayback {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private originTime = 0;
  private pausedAtMs: number | null = null;

  constructor(
    readonly passage: DecodedPassage,
    private readonly output: CloudAudioOutput,
    private readonly hooks: PlaybackHooks,
  ) {}

  get running(): boolean {
    return !!this.source && this.pausedAtMs === null;
  }

  get paused(): boolean {
    return this.pausedAtMs !== null;
  }

  elapsedMs(): number {
    if (this.pausedAtMs !== null) return this.pausedAtMs;
    const ctx = this.output.context;
    if (!ctx || !this.source) return 0;
    return Math.max(0, (ctx.currentTime - this.originTime) * 1000);
  }

  /** Context time at which this passage's last sentence, pause included, ends. */
  endTime(): number | null {
    if (!this.running) return null;
    const { endMs } = this.passage;
    return this.originTime + endMs[endMs.length - 1] / 1000;
  }

  /** Slack after a sentence's start within which a request to speak it is a
   *  normal advance rather than a jump back to its beginning. Generous, so a
   *  background tab whose timers are throttled to a second still carries on
   *  rather than repeating that second. */
  private static readonly ADVANCE_SLACK_MS = 1500;

  /** True when the playhead sits at the opening of this span — where a
   *  normal advance would find it — so playing the span need not restart
   *  anything. A playhead deep inside the span means a deliberate jump back
   *  to the sentence's start, which must rewind. */
  covers(fromMs: number, toMs: number): boolean {
    if (!this.running) return false;
    const now = this.elapsedMs();
    return now >= fromMs - 120 && now < Math.min(toMs, fromMs + PassagePlayback.ADVANCE_SLACK_MS);
  }

  /** Begin at `offsetMs` into the passage — now, or at context time `at`. */
  startAt(offsetMs: number, at?: number): void {
    const ctx = this.output.context;
    if (!ctx) return;
    this.stop();
    const source = ctx.createBufferSource();
    source.buffer = this.passage.buffer;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(1, ctx.currentTime);
    source.connect(gain);
    gain.connect(this.output.destination ?? ctx.destination);
    source.onended = () => {
      // The buffer ran out. The span may still be inside its closing pause,
      // and a queued passage may already be sounding; nothing to do here.
      if (this.source !== source) return;
    };
    const offset = Math.max(0, offsetMs / 1000);
    const when = Math.max(ctx.currentTime, at ?? ctx.currentTime);
    source.start(when, offset);
    this.source = source;
    this.gain = gain;
    this.originTime = when - offset;
    this.pausedAtMs = null;
    this.hooks.onStarted(this);
  }

  pause(): void {
    if (this.pausedAtMs !== null || !this.source) return;
    const at = this.elapsedMs();
    this.stop();
    this.pausedAtMs = at;
  }

  resume(): void {
    if (this.pausedAtMs === null) return;
    const at = this.pausedAtMs;
    this.pausedAtMs = null;
    this.startAt(at);
  }

  stop(): void {
    const source = this.source;
    const gain = this.gain;
    this.source = null;
    this.gain = null;
    if (!source) return;
    source.onended = null;
    const ctx = this.output.context;
    try {
      if (ctx && gain) {
        const now = ctx.currentTime;
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.025);
        source.stop(now + 0.035);
        setTimeout(() => {
          try {
            source.disconnect();
            gain.disconnect();
          } catch {
            /* already detached */
          }
        }, 80);
      } else {
        source.stop();
        source.disconnect();
      }
    } catch {
      /* already stopped */
    }
    this.hooks.onStopped(this);
  }
}

/**
 * One sentence's view of a passage that is already playing. It does not own
 * any audio: it watches the playhead, reports the words as they are reached,
 * and finishes when the sentence's span elapses.
 */
class PassageUtterance implements UtteranceHandle {
  private cancelled = false;
  private finished = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private nextWordIndex = 0;
  private readonly words: RawTimedWord[];

  constructor(
    private readonly playback: PassagePlayback,
    private readonly index: number,
    private readonly callbacks: SpeakCallbacks,
  ) {
    const { plan, words } = playback.passage;
    const sentence = plan.sentences[index];
    // Re-base the char indices onto the sentence, which is the text the
    // player and the highlighter know about.
    this.words = words
      .filter((word) => word.charIndex >= sentence.start && word.charIndex < sentence.end)
      .map((word) => ({ ...word, charIndex: word.charIndex - sentence.start }));
  }

  get done(): boolean {
    return this.finished || this.cancelled;
  }

  get playing(): boolean {
    return !this.done && this.playback.running;
  }

  get paused(): boolean {
    return !this.done && this.playback.paused;
  }

  start(): void {
    const { startMs, endMs } = this.playback.passage;
    // Only start the audio if it is not already at this sentence — the whole
    // point is that a normal advance does not restart anything.
    if (!this.playback.covers(startMs[this.index], endMs[this.index])) {
      this.playback.startAt(startMs[this.index]);
    }
    this.callbacks.onStart?.();
    this.watch();
  }

  private watch(): void {
    const { startMs, endMs } = this.playback.passage;
    const tick = () => {
      if (this.done) {
        this.stopWatching();
        return;
      }
      const now = this.playback.elapsedMs();
      while (
        this.nextWordIndex < this.words.length &&
        this.words[this.nextWordIndex].offsetMs <= now
      ) {
        const word = this.words[this.nextWordIndex];
        this.callbacks.onBoundary?.({
          charIndex: word.charIndex,
          charLength: word.charLength,
          elapsed: now - startMs[this.index],
        });
        this.nextWordIndex += 1;
      }
      if (now >= endMs[this.index]) {
        this.finished = true;
        this.stopWatching();
        this.callbacks.onEnd?.();
      }
    };
    this.stopWatching();
    this.ticker = setInterval(tick, WATCH_INTERVAL_MS);
  }

  private stopWatching(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  pause(): void {
    if (this.done) return;
    this.playback.pause();
  }

  resume(): void {
    if (this.done) return;
    this.playback.resume();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.stopWatching();
  }
}

/**
 * A sentence whose passage is still on its way. Stands in for the utterance
 * until the audio arrives, then hands over to a real PassageUtterance —
 * which is how the very first sentence of a session plays from the same
 * continuous reading as the ones after it, rather than as a clip of its own.
 */
class AwaitedUtterance implements UtteranceHandle {
  private cancelled = false;
  private failed = false;
  private inner: PassageUtterance | null = null;
  private wantPaused = false;

  constructor(
    private readonly callbacks: SpeakCallbacks,
    ready: Promise<unknown>,
    private readonly locate: () => { playback: PassagePlayback; index: number } | null,
  ) {
    ready.then(
      () => {
        if (this.cancelled) return;
        const found = this.locate();
        if (!found) {
          this.fail();
          return;
        }
        this.inner = new PassageUtterance(found.playback, found.index, this.callbacks);
        this.inner.start();
        if (this.wantPaused) this.inner.pause();
      },
      () => {
        if (!this.cancelled) this.fail();
      },
    );
  }

  private fail(): void {
    this.failed = true;
    const error: SpeechError = {
      kind: "synthesis-failed",
      message: "The cloud voice service didn't respond.",
    };
    this.callbacks.onError?.(error);
  }

  get done(): boolean {
    return this.cancelled || this.failed || !!this.inner?.done;
  }

  get playing(): boolean {
    return this.inner ? this.inner.playing : false;
  }

  get paused(): boolean {
    return this.inner ? this.inner.paused : this.wantPaused && !this.done;
  }

  pause(): void {
    this.wantPaused = true;
    this.inner?.pause();
  }

  resume(): void {
    this.wantPaused = false;
    this.inner?.resume();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.inner?.cancel();
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
  promise: Promise<DecodedSentence>;
}

interface PassageInFlight {
  key: string;
  plan: PassagePlan;
  promise: Promise<DecodedPassage>;
}

/**
 * Speaks through Microsoft Edge's cloud "Read Aloud" voices instead of
 * whatever is installed on the device. Synthesis happens on our own server
 * (see `/api/speech/edge/synthesize`) and comes back as one MP3 plus word
 * timings; this class tightens the silences, plays it, and paces
 * `onBoundary` against playback.
 */
export class EdgeSpeechEngine implements SpeechEngine {
  readonly id = "edge-tts";
  readonly providesWordTimings = true;

  private voices: EngineVoice[] = [];
  private readonly listeners = new Set<(voices: EngineVoice[]) => void>();
  private readyPromise: Promise<void> | null = null;
  private readonly output = new CloudAudioOutput();
  /** Sentences already decoded and able to start on the next audio tick. */
  private readonly decoded = new Map<string, DecodedSentence>();
  private current: EdgeUtterance | PassageUtterance | AwaitedUtterance | null = null;
  private pending: PendingPrefetch | null = null;
  /** The passage sounding now (or paused). */
  private playback: PassagePlayback | null = null;
  /** The next passage, scheduled on the audio clock to follow `playback`. */
  private queued: PassagePlayback | null = null;
  /** The next passage, decoded but not yet scheduled. */
  private nextPassage: DecodedPassage | null = null;
  private inFlight: PassageInFlight | null = null;
  private passagesPlanned = 0;
  private deferredStop: ReturnType<typeof setTimeout> | null = null;

  /** Every passage shares these; which one is speaking decides what they do. */
  private readonly hooks: PlaybackHooks = {
    onStarted: (playback) => {
      if (playback === this.playback) this.queueNext();
    },
    onStopped: (playback) => {
      if (playback === this.playback) this.dropQueued();
      else if (playback === this.queued) this.queued = null;
    },
  };

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
    if (!this.supported) return;
    this.output.activate();
  }

  /** Decoded audio is a few hundred KB a sentence, so only a short tail of
   *  already-heard sentences is worth keeping. */
  private rememberDecoded(key: string, sentence: DecodedSentence): void {
    this.decoded.set(key, sentence);
    while (this.decoded.size > DECODED_CACHE_LIMIT) {
      const oldest = this.decoded.keys().next().value;
      if (oldest === undefined) break;
      this.decoded.delete(oldest);
    }
  }

  /** Decode a lone sentence and tighten its silences. */
  private async decodeSentence(result: SynthesisResult, text: string): Promise<DecodedSentence> {
    const raw = await this.output.decode(result.bytes);
    const ctx = this.output.context;
    if (!ctx) return { buffer: raw, words: result.words };
    const span: SentenceSpan = { start: 0, end: text.length, endsParagraph: false };
    return tightenBuffer(ctx, raw, result.words, [span], LONE_SENTENCE_TIGHTEN);
  }

  /* ---------------------------------------------------------------- passages */

  /**
   * Takes the sentences about to be read and synthesises them together, so the
   * model shapes one continuous reading rather than a series of isolated
   * sentences each landing on a full stop.
   */
  prepare(sentences: PassageInput[], options: Omit<SpeakOptions, "text">): void {
    const shortName = edgeShortName(options.voiceId);
    if (!this.supported || !shortName || !sentences.length) return;

    // One passage ahead is enough. This is called at every sentence with a
    // window that slides forward, so without this the plan would change
    // slightly each time and the passage be synthesised again from scratch.
    if (this.nextPassage || this.inFlight) return;

    // Anything the passage in progress already covers is not ours to plan.
    const covered = new Set(this.playback?.passage.plan.sentences.map((s) => s.text) ?? []);
    const remaining = sentences.filter((entry) => !covered.has(entry.text.trim()));
    if (!remaining.length) return;

    const budget = PASSAGE_BUDGETS[Math.min(this.passagesPlanned, PASSAGE_BUDGETS.length - 1)];
    const plan = planPassage(remaining, budget);
    if (!plan) return;
    this.passagesPlanned += 1;

    const key = cacheKey(shortName, plan.text, options.rate);
    const promise = requestSynthesis(plan.text, shortName, options.rate, new AbortController().signal).then(
      async (result): Promise<DecodedPassage> => {
        const raw = await this.output.decode(result.bytes);
        const ctx = this.output.context;
        const tightened = ctx ? tightenBuffer(ctx, raw, result.words, plan.sentences) : { buffer: raw, words: result.words };
        const pause = pauseAfter(plan);
        const { startMs, endMs } = locateSentences(plan, tightened.words, tightened.buffer.duration * 1000, pause);
        return { key, plan, buffer: tightened.buffer, words: tightened.words, startMs, endMs, pauseAfterMs: pause };
      },
    );
    this.inFlight = { key, plan, promise };

    promise
      .then((passage) => {
        if (this.inFlight?.key !== key) return;
        this.inFlight = null;
        this.nextPassage = passage;
        this.queueNext();
      })
      .catch(() => {
        if (this.inFlight?.key === key) this.inFlight = null;
      });
  }

  /** Schedule the decoded next passage to begin the instant the current one
   *  ends, so the seam is placed by the audio clock rather than by a timer. */
  private queueNext(): void {
    if (this.queued || !this.nextPassage || !this.playback?.running) return;
    const at = this.playback.endTime();
    if (at === null) return;
    const queued = new PassagePlayback(this.nextPassage, this.output, this.hooks);
    this.queued = queued;
    queued.startAt(this.nextPassage.startMs[0], at);
  }

  private dropQueued(): void {
    const queued = this.queued;
    this.queued = null;
    queued?.stop();
  }

  /** Make the next passage the current one. */
  private promote(): PassagePlayback | null {
    const passage = this.nextPassage;
    if (!passage) return null;
    this.nextPassage = null;
    const queued = this.queued;
    this.queued = null;
    const previous = this.playback;
    this.playback = null;
    // The previous passage has either run out or is being left; a queued
    // passage is already on the clock and simply becomes current.
    previous?.stop();
    this.playback = queued ?? new PassagePlayback(passage, this.output, this.hooks);
    return this.playback;
  }

  /** The passage holding this sentence, if one is ready. */
  private passageFor(text: string): { playback: PassagePlayback; index: number } | null {
    const trimmed = text.trim();
    const inCurrent = this.playback?.passage.plan.sentences.findIndex((s) => s.text === trimmed);
    if (this.playback && inCurrent !== undefined && inCurrent >= 0) {
      return { playback: this.playback, index: inCurrent };
    }
    const inNext = this.nextPassage?.plan.sentences.findIndex((s) => s.text === trimmed);
    if (this.nextPassage && inNext !== undefined && inNext >= 0) {
      const playback = this.promote();
      return playback ? { playback, index: inNext } : null;
    }
    return null;
  }

  /* ---------------------------------------------------------------- sentences */

  /**
   * Starts fetching a sentence's audio without playing it, so that by the
   * time the player actually asks to speak it (once the current sentence
   * ends), it's already downloaded. Without this, every sentence boundary
   * pays the full round trip to Microsoft as silence.
   */
  prefetch(options: SpeakOptions): void {
    const shortName = edgeShortName(options.voiceId);
    if (!this.supported || !shortName || !options.text.trim()) return;

    // A sentence a passage already covers must not also be synthesised on its
    // own: the two requests compete for the same connection, and the
    // single-sentence copy would be thrown away unheard.
    const trimmed = options.text.trim();
    const inPlan = (plan: PassagePlan | null | undefined) =>
      plan?.sentences.some((sentence) => sentence.text === trimmed) ?? false;
    if (inPlan(this.playback?.passage.plan) || inPlan(this.nextPassage?.plan) || inPlan(this.inFlight?.plan)) return;
    // A passage on its way will cover this sentence and more; fetching it
    // alone as well would only compete with it for the connection.
    if (this.nextPassage || this.inFlight) return;

    const key = cacheKey(shortName, options.text, options.rate);
    if (this.pending?.key === key) return;
    this.clearPending();

    const controller = new AbortController();
    // Decoding is the half that actually costs time at the sentence boundary,
    // and it is the half an <audio> element refuses to do early on iOS. Doing
    // it here leaves speak() with nothing to do but schedule the buffer.
    const promise = requestSynthesis(options.text, shortName, options.rate, controller.signal).then(
      (result) => this.decodeSentence(result, options.text),
    );
    this.pending = { key, controller, promise };

    promise
      .then((sentence) => {
        if (this.pending?.key === key) this.pending = null;
        this.rememberDecoded(key, sentence);
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
    stale.promise.catch(() => {});
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
    if (this.deferredStop) {
      clearTimeout(this.deferredStop);
      this.deferredStop = null;
    }

    // Preferred path: this sentence is part of a passage that was synthesised
    // as one continuous reading, so playback simply carries on into it.
    const inPassage = this.passageFor(options.text);
    if (inPassage) {
      const utterance = new PassageUtterance(inPassage.playback, inPassage.index, callbacks);
      this.current = utterance;
      utterance.start();
      return utterance;
    }

    // Its passage is on its way: wait for that rather than fetch the sentence
    // alone, which would arrive no sooner and read as a clip of its own.
    const trimmed = options.text.trim();
    if (this.inFlight?.plan.sentences.some((sentence) => sentence.text === trimmed)) {
      const utterance = new AwaitedUtterance(callbacks, this.inFlight.promise, () => this.passageFor(options.text));
      this.current = utterance;
      return utterance;
    }

    const key = cacheKey(shortName, options.text, options.rate);

    const acquire = async (signal: AbortSignal): Promise<DecodedSentence> => {
      // The fast path: decoded while the previous sentence was still playing,
      // so there is nothing to download and nothing to decode.
      const ready = this.decoded.get(key);
      if (ready) return ready;

      if (this.pending?.key === key) {
        const inFlight = this.pending;
        this.pending = null;
        return inFlight.promise;
      }
      const result = await requestSynthesis(options.text, shortName, options.rate, signal);
      const sentence = await this.decodeSentence(result, options.text);
      this.rememberDecoded(key, sentence);
      return sentence;
    };

    this.playback?.stop();
    this.playback = null;
    const utterance = new EdgeUtterance(callbacks, this.output, acquire);
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
    // The player cancels before every sentence, a normal advance included, so
    // stopping the passage here would undo the very continuity it exists for.
    // Defer it by a turn: a speak() that follows immediately calls it off, and
    // a genuine stop — pausing for good, seeking away, the sleep timer — has
    // nothing following it, so the audio does stop.
    if (this.deferredStop) clearTimeout(this.deferredStop);
    this.deferredStop = setTimeout(() => {
      this.deferredStop = null;
      this.playback?.stop();
      this.playback = null;
      this.dropQueued();
    }, 0);
  }

  isSpeaking(): boolean {
    return !!this.current?.playing;
  }

  isPaused(): boolean {
    return !!this.current?.paused;
  }

  destroy(): void {
    this.cancel();
    if (this.deferredStop) clearTimeout(this.deferredStop);
    this.deferredStop = null;
    this.playback?.stop();
    this.playback = null;
    this.dropQueued();
    this.nextPassage = null;
    this.inFlight = null;
    this.clearPending();
    this.decoded.clear();
    this.listeners.clear();
    this.output.shutdown();
  }
}
