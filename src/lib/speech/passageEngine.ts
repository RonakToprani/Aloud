import type {
  BoundaryEvent,
  EngineVoice,
  SpeakCallbacks,
  SpeakOptions,
  SpeechEngine,
  SpeechError,
  SpeechErrorKind,
  UtteranceHandle,
} from "./engine";
import { planPassage, type PassageInput, type PassagePlan, type PassageSentence } from "./edge/passage";
import {
  applyCuts,
  DEFAULT_TIGHTEN,
  planCuts,
  remapWords,
  type SentenceSpan,
  type TightenSettings,
} from "./edge/tighten";

/** A minimal, always-silent WAV. Playing it once inside a user gesture is
 *  enough to mark this <audio> element as activated for the rest of the
 *  page's lifetime on iOS Safari, so a later programmatic play() (after an
 *  async fetch) is allowed even outside a gesture. */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/** A word located in a clip, in milliseconds from the clip's start. */
export interface TimedWord {
  charIndex: number;
  charLength: number;
  offsetMs: number;
  durationMs: number;
}

export interface SynthesisedAudio {
  buffer: AudioBuffer;
  words: TimedWord[];
}

/** One request to a source: a passage of sentences, or one sentence alone. */
export interface PassageRequest {
  text: string;
  /** Where each sentence sits in `text`. One entry for a lone sentence. */
  sentences: PassageSentence[];
  /** The source's own voice id, prefix removed. */
  voice: string;
  rate: number;
}

/**
 * Where a passage engine's audio comes from.
 *
 * The engine owns everything that is hard about playing synthesised prose:
 * passages, the seam between them, pausing, the audio session. A source owns
 * only the turning of text into a buffer with word timings, which is the one
 * part a cloud service and a model running on the device do differently.
 */
export interface SynthesisSource {
  /** The engine id reported upwards. */
  readonly id: string;
  /** Voice ids this source answers to begin with this. */
  readonly prefix: string;
  /** How much text each successive passage asks for. The first is small so
   *  pressing play feels immediate; later ones are made while the previous
   *  plays and can be larger. */
  readonly budgets: readonly number[];
  /** Whether the audio needs its silences trimmed (see edge/tighten.ts). A
   *  source that already paces its sentences says false. */
  readonly tighten: boolean;
  /** What the reader is told when a request fails. */
  readonly failureMessage: string;
  supported(): boolean;
  /** Resolves once the voices are known, or the source has given up. */
  loadVoices(): Promise<EngineVoice[]>;
  /** Buffers are created on `ctx`, which may still be suspended. */
  synthesize(request: PassageRequest, ctx: BaseAudioContext, signal: AbortSignal): Promise<SynthesisedAudio>;
  /** Runs inside the gesture that unlocked audio, for anything that must. */
  warm?(): void;
  /** The engine is going away. */
  destroy?(): void;
}

/** A sentence decoded and able to start on the next audio tick. */
type DecodedSentence = SynthesisedAudio;

/** How many decoded sentences to keep for a skip backwards. */
const DECODED_CACHE_LIMIT = 8;

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
  words: TimedWord[],
  sentences: SentenceSpan[],
  settings: TightenSettings = DEFAULT_TIGHTEN,
): { buffer: AudioBuffer; words: TimedWord[] } {
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
 * Where synthesised audio comes out.
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
class AudioOutput {
  private ctx: AudioContext | null = null;
  private sessionHolder: HTMLAudioElement | null = null;
  private silenceUrl: string | null = null;
  /** When available, the graph feeds the element instead of the speakers
   *  directly, so iOS sees ordinary media playback. */
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  /** Keeps the stream fed between sentences — see startSilentFeed. */
  private silentFeed: AudioBufferSourceNode | null = null;
  private readonly onVisible = () => {
    if (document.visibilityState === "visible") this.ensureAudible();
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

  /**
   * Put the output back where it can be heard. Two separate things stop on
   * their own and neither restarts: iOS suspends the context whenever the
   * page loses focus, and it pauses the session holder whenever another app
   * takes the audio session. A paused holder is the worse of the two, because
   * the context keeps running and so does its clock: the highlight walks the
   * sentence and the book advances in silence.
   *
   * Deliberately not awaited. A suspended context's clock is frozen, so a
   * time computed now is still the right time when it comes back, and
   * nothing needs re-scheduling — which is what lets this sit in front of
   * audio that is about to be scheduled on that clock.
   */
  ensureAudible(): void {
    const ctx = this.ensureContext();
    if (ctx && ctx.state !== "running") void ctx.resume().catch(() => {});
    if (this.sessionHolder?.paused) void this.sessionHolder.play().catch(() => {});
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

class LoneUtterance implements UtteranceHandle {
  private cancelled = false;
  private finished = false;
  private readonly controller = new AbortController();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private words: TimedWord[] = [];
  private nextWordIndex = 0;

  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  /** Context time that the buffer's zero offset corresponds to. */
  private originTime = 0;
  private pausedAt: number | null = null;

  constructor(
    private readonly callbacks: SpeakCallbacks,
    private readonly output: AudioOutput,
    private readonly acquire: (signal: AbortSignal) => Promise<DecodedSentence>,
    private readonly failureMessage: string,
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
        this.fail("synthesis-failed", "This browser can't play audio.");
        return;
      }
      // Resumed here as well as on activate: iOS suspends the context whenever
      // the page loses focus, and a suspended context plays nothing.
      if (ctx.state === "suspended") await ctx.resume().catch(() => {});
      if (this.cancelled) return;

      // Paused while the audio was still on its way: hold it, and let
      // resume() start it from the beginning rather than playing now.
      if (this.pausedAt !== null) {
        this.callbacks.onStart?.();
        return;
      }
      this.playFrom(0);
      this.output.keepSessionAlive();
      this.callbacks.onStart?.();
      this.scheduleBoundaries();
    } catch (error) {
      if (this.cancelled) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      this.fail("synthesis-failed", this.failureMessage);
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
    const fade = LoneUtterance.FADE_SECONDS;
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
    // resume starts a fresh source from there. With nothing playing yet — the
    // audio is still on its way — the offset is the beginning: `elapsed()`
    // would measure the context's whole lifetime against an origin of zero,
    // and resume would then start the clip past its own end, silently.
    const at = this.source ? this.elapsed() : 0;
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
      // The audio may not have arrived yet; start() will see pausedAt cleared
      // by playFrom and carry on as normal once it does.
      if (!this.buffer) {
        this.pausedAt = null;
        return;
      }
      this.playFrom(offset);
      this.scheduleBoundaries();
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
  words: TimedWord[];
  startMs: number[];
  /** A sentence's span ends where the next begins; the last one's ends a
   *  pause after the audio does, which is when the next passage is due. */
  endMs: number[];
  /** Silence owed after the last word, before whatever follows. */
  pauseAfterMs: number;
}

/** Locate each sentence in the tightened audio using the word timings, whose
 *  char indices address the passage as a whole. Exported for the tests: what
 *  it does to a passage the voice timed badly decides whether the reader
 *  hears the paragraph or hears it start over. */
export function locateSentences(
  plan: PassagePlan,
  words: TimedWord[],
  durationMs: number,
  pauseAfterMs: number,
): { startMs: number[]; endMs: number[] } {
  const startMs: number[] = [];
  for (const sentence of plan.sentences) {
    const first = words.find((word) => word.charIndex >= sentence.start);
    // A sentence the voice returned no word for starts where the one before
    // it did, never at zero. Zero would put a sentence's span before the
    // span of the sentence ahead of it, and the player reads a span that has
    // already elapsed as the sentence ending instantly — then rewinds the
    // passage to the top and hears the paragraph start over.
    const previous = startMs.length ? startMs[startMs.length - 1] : 0;
    startMs.push(first ? Math.max(first.offsetMs, previous) : previous);
  }
  // A sentence runs until the next one opens, so no audio is ever skipped —
  // trailing pauses belong to the sentence that caused them. A span is never
  // allowed to be empty: an untimed sentence is passed through quickly, which
  // is survivable, where a negative span is not.
  const endMs = startMs.map((start, i) =>
    Math.max(i + 1 < startMs.length ? startMs[i + 1] : durationMs + pauseAfterMs, start + 1),
  );
  return { startMs, endMs };
}

/** Exported for the tests: which pause a passage owes whatever follows it. */
export function pauseAfter(plan: PassagePlan): number {
  const last = plan.sentences[plan.sentences.length - 1];
  if (last?.isHeading) return DEFAULT_TIGHTEN.headingPauseMs;
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
  /** Context time the source was told to begin at, which for a passage
   *  scheduled on the seam is in the future. */
  private startWhen = 0;
  private pausedAtMs: number | null = null;

  constructor(
    readonly passage: DecodedPassage,
    private readonly output: AudioOutput,
    private readonly hooks: PlaybackHooks,
  ) {}

  get running(): boolean {
    return !!this.source && this.pausedAtMs === null;
  }

  /** A passage scheduled to begin on the seam has a source but has not made a
   *  sound yet. Saying so is what keeps a passage promoted ahead of its time
   *  from looking like playback: one scheduled a whole passage into the future
   *  used to report itself running and audible, so the player's own check saw
   *  a reader being read to and the reading sat in silence with no way out. */
  private get pending(): boolean {
    const ctx = this.output.context;
    return !!this.source && !!ctx && ctx.currentTime < this.startWhen;
  }

  /**
   * Whether a sound is actually coming out, as opposed to whether we think we
   * started one. A source attached to a suspended context is not playing,
   * however much it looks like it is, and nor is one whose start time has not
   * arrived; reporting otherwise hides the failure from the player's recovery
   * — which is how a restart after the phone was locked used to leave a reader
   * watching the words move in silence with no way out but a pause and a press
   * of play.
   *
   * Kept apart from `running`, which the passage queue is built on: gating
   * that on the context state would void a queued passage and put the gap
   * back into every seam.
   */
  get audible(): boolean {
    return this.running && !this.pending && this.output.context?.state === "running";
  }

  get paused(): boolean {
    return this.pausedAtMs !== null;
  }

  /**
   * Where the playhead is, in ms into the passage. Negative before a passage
   * scheduled on the seam begins, and deliberately so: clamping it at zero
   * made "this has not started yet" indistinguishable from "this is at the
   * very beginning", and `covers` then left a passage due seconds from now
   * exactly where it was instead of starting it.
   */
  elapsedMs(): number {
    if (this.pausedAtMs !== null) return this.pausedAtMs;
    const ctx = this.output.context;
    if (!ctx || !this.source) return 0;
    return (ctx.currentTime - this.originTime) * 1000;
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
    // Every start, not only the first: the single-sentence path has always
    // done this, and the passage path — the one cloud voices actually use —
    // did not, so a passage scheduled after a lock or an interruption was
    // scheduled onto something that could not sound.
    this.output.ensureAudible();
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
    this.startWhen = when;
    this.originTime = when - offset;
    this.pausedAtMs = null;
    this.hooks.onStarted(this);
  }

  pause(): void {
    if (this.pausedAtMs !== null || !this.source) return;
    // Never negative: a passage paused before its scheduled start has not been
    // heard at all, and resume then belongs at the sentence being read, which
    // PassageUtterance.resume puts it at.
    const at = Math.max(0, this.elapsedMs());
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
  private readonly words: TimedWord[];

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
    return !this.done && this.playback.audible;
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
      // A paused passage's playhead is frozen, and a pause landing in the last
      // tick of a sentence froze it past the sentence's end — which was read
      // as the sentence finishing, so the player advanced and started reading
      // again about forty milliseconds after the reader pressed pause.
      if (this.playback.paused) return;
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
    this.stopWatching();
  }

  resume(): void {
    if (this.done) return;
    const { startMs } = this.playback.passage;
    this.playback.resume();
    // Only when the audio came back behind the sentence being read, which is
    // what a passage paused before its scheduled start has to come back to:
    // it has no playhead of its own, and resuming at the top of the passage
    // would read one sentence while the page lit another. A playhead past the
    // end of the span is this sentence finishing, and the watcher below
    // reports that as the ordinary advance it is.
    if (this.playback.running && this.playback.elapsedMs() < startMs[this.index] - 120) {
      this.playback.startAt(startMs[this.index]);
    }
    this.watch();
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
    private readonly failureMessage: string,
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
        // Paused while the passage was on its way: hold it until resume.
        if (!this.wantPaused) this.startInner();
      },
      () => {
        if (!this.cancelled) this.fail();
      },
    );
  }

  private started = false;

  private startInner(): void {
    if (!this.inner || this.started) return;
    this.started = true;
    this.inner.start();
  }

  private fail(): void {
    this.failed = true;
    const error: SpeechError = { kind: "synthesis-failed", message: this.failureMessage };
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
    if (this.inner && !this.started) this.startInner();
    else this.inner?.resume();
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.inner?.cancel();
  }
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
 * Plays synthesised prose from any `SynthesisSource` as one continuous
 * reading: sentences are synthesised together as passages, the next passage
 * is made while the current one plays and scheduled on the audio clock to
 * follow it, and `onBoundary` is paced against playback from the word
 * timings that came with the audio. The cloud voices and the offline model
 * are two sources behind this one class.
 */
export class PassageSpeechEngine implements SpeechEngine {
  readonly id: string;
  readonly providesWordTimings = true;

  private voices: EngineVoice[] = [];
  private readonly listeners = new Set<(voices: EngineVoice[]) => void>();
  private readyPromise: Promise<void> | null = null;
  private readonly output = new AudioOutput();
  /** Sentences already decoded and able to start on the next audio tick. */
  private readonly decoded = new Map<string, DecodedSentence>();
  private current: LoneUtterance | PassageUtterance | AwaitedUtterance | null = null;
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
  /** Which voice, at which speed, everything currently fetched, decoded or
   *  scheduled was made for. A passage is matched to a sentence by its text,
   *  which says nothing about who is reading it. */
  private passageVoice: string | null = null;
  private passageRate = 1;

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

  constructor(protected readonly source: SynthesisSource) {
    this.id = source.id;
  }

  get supported(): boolean {
    return typeof window !== "undefined" && typeof Audio !== "undefined" && this.source.supported();
  }

  ready(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.loadVoices();
    return this.readyPromise;
  }

  private async loadVoices(): Promise<void> {
    if (!this.supported) return;
    try {
      this.voices = await this.source.loadVoices();
    } catch {
      // These voices are a bonus; the device's own carry the reader if this fails.
      this.voices = [];
    }
    this.announceVoices();
  }

  /** Tell the picker the list changed, as a source may once it has learned
   *  something new, such as that its model has finished downloading. */
  protected announceVoices(): void {
    const snapshot = this.voices;
    for (const listener of this.listeners) listener(snapshot);
  }

  /** The voice id of this source, stripped of its prefix, or null for a voice
   *  belonging to some other engine. */
  private voiceOf(voiceId: string | null | undefined): string | null {
    return voiceId?.startsWith(this.source.prefix) ? voiceId.slice(this.source.prefix.length) : null;
  }

  /** The one place a request leaves this file. Shared by every path so a
   *  sentence fetched ahead of time and one fetched on demand go through the
   *  exact same code. */
  private request(
    text: string,
    sentences: PassageSentence[],
    voice: string,
    rate: number,
    signal: AbortSignal,
  ): Promise<SynthesisedAudio> {
    const ctx = this.output.context;
    if (!ctx) return Promise.reject(new Error("This browser has no Web Audio support."));
    return this.source.synthesize({ text, sentences, voice, rate }, ctx, signal);
  }

  private static loneSpan(text: string): PassageSentence {
    return { text, start: 0, end: text.length, endsParagraph: false, isHeading: false };
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
    this.source.warm?.();
  }

  /**
   * Note which voice and speed the reading is now in, and throw away anything
   * belonging to another one.
   *
   * A passage answers a sentence by matching its text, and text alone cannot
   * tell one voice from another. So a passage fetched and scheduled under the
   * old voice went on answering sentences after the reader had changed voice:
   * the new voice spoke the part-sentence it was asked for and the old one
   * picked the book up again at the next full sentence and carried on. The
   * lookahead, the fetch on its way and the audio already on the clock all
   * belong to the voice that asked for them.
   */
  private useVoice(voice: string, rate: number): void {
    if (this.passageVoice === voice && this.passageRate === rate) return;
    const first = this.passageVoice === null;
    this.passageVoice = voice;
    this.passageRate = rate;
    if (!first) this.dropPassages();
  }

  /** Stop and forget every passage: playing, scheduled, decoded and in flight. */
  private dropPassages(): void {
    if (this.deferredStop) clearTimeout(this.deferredStop);
    this.deferredStop = null;
    const playing = this.playback;
    this.playback = null;
    playing?.stop();
    this.dropQueued();
    this.nextPassage = null;
    this.inFlight = null;
    // The budget starts over: the next thing played deserves the small,
    // quick first passage rather than a minute of someone else's voice.
    this.passagesPlanned = 0;
    this.clearPending();
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

  /** Tighten a lone sentence's silences, if this source's audio needs it. */
  private tightenSentence(result: SynthesisedAudio, text: string): DecodedSentence {
    const ctx = this.output.context;
    if (!ctx || !this.source.tighten) return result;
    const span: SentenceSpan = { start: 0, end: text.length, endsParagraph: false };
    return tightenBuffer(ctx, result.buffer, result.words, [span], LONE_SENTENCE_TIGHTEN);
  }

  /* ---------------------------------------------------------------- passages */

  /**
   * Takes the sentences about to be read and synthesises them together, so the
   * model shapes one continuous reading rather than a series of isolated
   * sentences each landing on a full stop.
   */
  prepare(sentences: PassageInput[], options: Omit<SpeakOptions, "text">): void {
    const voice = this.voiceOf(options.voiceId);
    if (!this.supported || !voice || !sentences.length) return;
    this.useVoice(voice, options.rate);

    // One passage ahead is enough. This is called at every sentence with a
    // window that slides forward, so without this the plan would change
    // slightly each time and the passage be synthesised again from scratch.
    if (this.nextPassage || this.inFlight) return;

    // Anything the passage in progress already covers is not ours to plan.
    const covered = new Set(this.playback?.passage.plan.sentences.map((s) => s.text) ?? []);
    const remaining = sentences.filter((entry) => !covered.has(entry.text.trim()));
    if (!remaining.length) return;

    const budgets = this.source.budgets;
    const budget = budgets[Math.min(this.passagesPlanned, budgets.length - 1)];
    const plan = planPassage(remaining, budget);
    if (!plan) return;
    this.passagesPlanned += 1;

    const key = cacheKey(voice, plan.text, options.rate);
    const promise = this.request(plan.text, plan.sentences, voice, options.rate, new AbortController().signal).then(
      (result): DecodedPassage => {
        const ctx = this.output.context;
        const tightened =
          ctx && this.source.tighten ? tightenBuffer(ctx, result.buffer, result.words, plan.sentences) : result;
        // Without word timings a passage cannot be divided into sentences:
        // every span would land on the same instant and the paragraph would
        // flash past in silence. Refuse it and let the lone-sentence path,
        // which can fall back to an estimated pace, read it instead.
        if (!tightened.words.length) {
          throw new Error("The passage came back with no word timings.");
        }
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
    const voice = this.voiceOf(options.voiceId);
    if (!this.supported || !voice || !options.text.trim()) return;
    this.useVoice(voice, options.rate);

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

    const key = cacheKey(voice, options.text, options.rate);
    if (this.pending?.key === key) return;
    this.clearPending();

    const controller = new AbortController();
    // Decoding is the half that actually costs time at the sentence boundary,
    // and it is the half an <audio> element refuses to do early on iOS. Doing
    // it here leaves speak() with nothing to do but schedule the buffer.
    const promise = this.request(
      options.text,
      [PassageSpeechEngine.loneSpan(options.text)],
      voice,
      options.rate,
      controller.signal,
    ).then((result) => this.tightenSentence(result, options.text));
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
    const voice = this.voiceOf(options.voiceId);
    if (!this.supported || !voice) {
      const error: SpeechError = {
        kind: "no-voices",
        message: "No voice is selected.",
      };
      queueMicrotask(() => callbacks.onError?.(error));
      return { cancel() {}, done: true };
    }
    if (this.deferredStop) {
      clearTimeout(this.deferredStop);
      this.deferredStop = null;
    }
    // Before anything is matched: a passage belonging to another voice or speed
    // must not be allowed to answer this sentence.
    this.useVoice(voice, options.rate);

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
      const utterance = new AwaitedUtterance(
        callbacks,
        this.inFlight.promise,
        () => this.passageFor(options.text),
        this.source.failureMessage,
      );
      this.current = utterance;
      return utterance;
    }

    const key = cacheKey(voice, options.text, options.rate);

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
      const result = await this.request(
        options.text,
        [PassageSpeechEngine.loneSpan(options.text)],
        voice,
        options.rate,
        signal,
      );
      const sentence = this.tightenSentence(result, options.text);
      this.rememberDecoded(key, sentence);
      return sentence;
    };

    this.playback?.stop();
    this.playback = null;
    const utterance = new LoneUtterance(callbacks, this.output, acquire, this.source.failureMessage);
    this.current = utterance;
    void utterance.start();
    return utterance;
  }

  pause(): void {
    this.current?.pause();
    // A pause must leave nothing sounding, and the utterance cannot always
    // manage that on its own: one still waiting for its own passage to arrive
    // has no hold over the passage already on the clock, which went on reading
    // aloud with the reader having asked for quiet.
    if (!this.playback?.paused) this.playback?.pause();
  }

  resume(): void {
    const before = this.playback;
    this.current?.resume();
    // Only the passage the utterance left paused, and only if nothing else has
    // taken its place meanwhile: a passage the promotion above has moved on
    // from must stay stopped.
    if (before && before === this.playback && before.paused) before.resume();
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
      // A genuine stop abandons the place being left, and with it the passage
      // that was planned to follow it. Left behind, that passage matches no
      // sentence ever again, and the one-passage-ahead guards in prepare()
      // and prefetch() then refuse every future one — so from here on every
      // sentence boundary would pay a full round trip to Microsoft as
      // silence, and a slow one trips the start-timeout watchdog into
      // "this voice produced no sound". The budget goes back to the start
      // too: the next press of play deserves the small first passage.
      this.nextPassage = null;
      this.inFlight = null;
      this.passagesPlanned = 0;
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
    this.source.destroy?.();
  }
}
