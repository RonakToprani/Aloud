/**
 * Drives the real cloud engine under Node.
 *
 * The bugs this exists for are races between a pause, an in-flight passage
 * fetch and audio already scheduled on the audio clock, and none of them can
 * be reached through a fake engine: they live in `edge/engine.ts` itself. So
 * the browser pieces it needs — an AudioContext, an <audio> element, fetch —
 * are stubbed here, closely enough that the engine takes its real paths, and
 * every buffer that reaches `source.start()` is attributed back to the voice
 * that synthesised it by its amplitude, which survives tightening because
 * tightening only removes samples.
 */

interface StubWord {
  charIndex: number;
  charLength: number;
  offsetMs: number;
  durationMs: number;
}

/** What the synthesis endpoint is pretending to return. */
interface StubPayload {
  amp: number;
  words: StubWord[];
  durationMs: number;
}

export interface ScheduledStart {
  /** The voice whose audio this is, recovered from the waveform. */
  voice: string;
  when: number;
  offset: number;
  /** Wall-clock ms since the harness started. */
  at: number;
  loop: boolean;
}

export interface SynthesisCall {
  text: string;
  voice: string;
  rate: number;
  /** Resolve or reject this request by hand. */
  settle: () => void;
  fail: () => void;
  settled: boolean;
}

const SAMPLE_RATE = 8000;
/** Amplitude carries the voice's identity through decode and tightening. */
const VOICE_AMPLITUDE = new Map<string, number>();
function amplitudeFor(voice: string): number {
  if (!VOICE_AMPLITUDE.has(voice)) VOICE_AMPLITUDE.set(voice, 0.2 + VOICE_AMPLITUDE.size * 0.25);
  return VOICE_AMPLITUDE.get(voice)!;
}
function voiceForAmplitude(amp: number): string {
  for (const [voice, value] of VOICE_AMPLITUDE) {
    if (Math.abs(value - amp) < 0.02) return voice;
  }
  return `unknown(${amp.toFixed(3)})`;
}

class StubAudioBuffer {
  readonly numberOfChannels = 1;
  readonly sampleRate = SAMPLE_RATE;
  private readonly data: Float32Array;

  constructor(length: number, data?: Float32Array) {
    this.data = data ?? new Float32Array(length);
  }
  get length(): number {
    return this.data.length;
  }
  get duration(): number {
    return this.data.length / SAMPLE_RATE;
  }
  getChannelData(): Float32Array {
    return this.data;
  }
  copyToChannel(source: Float32Array): void {
    this.data.set(source.subarray(0, this.data.length));
  }
  /** Loudest sample, which is how a buffer says which voice made it. */
  peak(): number {
    let peak = 0;
    for (const value of this.data) peak = Math.max(peak, Math.abs(value));
    return peak;
  }
}

function renderPayload(payload: StubPayload): StubAudioBuffer {
  const length = Math.ceil((payload.durationMs / 1000) * SAMPLE_RATE);
  const buffer = new StubAudioBuffer(length);
  const samples = buffer.getChannelData();
  for (const word of payload.words) {
    const from = Math.floor((word.offsetMs / 1000) * SAMPLE_RATE);
    const to = Math.min(length, Math.ceil(((word.offsetMs + word.durationMs) / 1000) * SAMPLE_RATE));
    // A square wave at the voice's amplitude: loud enough never to read as
    // silence, and its peak is the voice's signature.
    for (let i = from; i < to; i++) samples[i] = i % 2 === 0 ? payload.amp : -payload.amp;
  }
  return buffer;
}

class StubGainNode {
  readonly gain = {
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
  };
  connect(): void {}
  disconnect(): void {}
}

class StubBufferSource {
  buffer: StubAudioBuffer | null = null;
  loop = false;
  onended: (() => void) | null = null;
  private stopped = false;
  private watch: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: StubAudioContext) {}
  connect(): void {}
  disconnect(): void {}
  start(when = this.ctx.currentTime, offset = 0): void {
    this.ctx.record(this, when, offset);
    if (this.loop) return;
    // A real source fires `ended` when the buffer runs out, and an offset past
    // the end of the buffer means it ends without ever making a sound — which
    // is exactly what a mis-computed resume offset does.
    const endsAt = when + Math.max(0, (this.buffer?.duration ?? 0) - offset);
    this.watch = setInterval(() => {
      if (this.stopped) return this.clearWatch();
      if (this.ctx.currentTime < endsAt) return;
      this.clearWatch();
      this.onended?.();
    }, 20);
  }
  private clearWatch(): void {
    if (this.watch !== null) clearInterval(this.watch);
    this.watch = null;
  }
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearWatch();
  }
}

export class StubAudioContext {
  state: "suspended" | "running" | "closed" = "suspended";
  readonly sampleRate = SAMPLE_RATE;
  readonly destination = {};
  /** Advances with wall time whenever the context is running, and freezes
   *  while it is suspended, exactly as a real one does. */
  private elapsed = 0;
  private lastRead = Date.now();
  resumeCalls = 0;
  /** Set to make resume() never settle, as iOS sometimes does. */
  stallResume = false;

  readonly starts: ScheduledStart[] = [];
  private readonly t0 = Date.now();

  get currentTime(): number {
    const now = Date.now();
    if (this.state === "running") this.elapsed += (now - this.lastRead) / 1000;
    this.lastRead = now;
    return this.elapsed;
  }

  record(source: StubBufferSource, when: number, offset: number): void {
    const peak = source.buffer?.peak() ?? 0;
    this.starts.push({
      voice: source.loop || peak === 0 ? "silence" : voiceForAmplitude(peak),
      when,
      offset,
      at: Date.now() - this.t0,
      loop: source.loop,
    });
  }

  createBufferSource(): StubBufferSource {
    return new StubBufferSource(this);
  }
  createGain(): StubGainNode {
    return new StubGainNode();
  }
  createBuffer(_channels: number, length: number): StubAudioBuffer {
    return new StubAudioBuffer(length);
  }
  createMediaStreamDestination() {
    return { stream: { id: "stub" }, disconnect() {} };
  }
  async decodeAudioData(bytes: ArrayBuffer): Promise<StubAudioBuffer> {
    const text = Buffer.from(bytes).toString("utf8");
    return renderPayload(JSON.parse(text) as StubPayload);
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.stallResume) return new Promise<void>(() => {});
    this.lastRead = Date.now();
    this.state = "running";
  }
  async suspend(): Promise<void> {
    void this.currentTime; // bank the time before freezing
    this.state = "suspended";
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
}

export interface Harness {
  ctx: StubAudioContext;
  /** Every synthesis request, oldest first. */
  calls: SynthesisCall[];
  /** Requests answered automatically after `latencyMs`; set to null to hold
   *  every request until it is settled by hand. */
  latencyMs: number | null;
  /** Audio actually scheduled, silence and keep-alive feeds excluded. */
  audible(): ScheduledStart[];
  /** Voices whose audio was scheduled, in order. */
  voiceOrder(): string[];
  sessionHolderPaused(): boolean;
  restore(): void;
}

const WORD_MS = 240;
const SENTENCE_SILENCE_MS = 1000;

/** Times a passage the way Edge does: a word every WORD_MS, a second of dead
 *  air after every sentence. */
function timePassage(text: string, amp: number): StubPayload {
  const words: StubWord[] = [];
  let cursor = 200; // Edge leaves ~200ms before the first word
  const re = /[^\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    words.push({
      charIndex: match.index,
      charLength: match[0].length,
      offsetMs: cursor,
      durationMs: WORD_MS,
    });
    cursor += WORD_MS;
    if (/[.!?]["')\]]?$/.test(match[0])) cursor += SENTENCE_SILENCE_MS;
  }
  return { amp, words, durationMs: cursor + SENTENCE_SILENCE_MS };
}

export function installHarness(): Harness {
  const ctx = new StubAudioContext();
  const holders: { paused: boolean }[] = [];
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, unknown>();
  const set = (key: string, value: unknown) => {
    saved.set(key, globals[key]);
    globals[key] = value;
  };

  class StubAudio {
    loop = false;
    src = "";
    srcObject: unknown = null;
    paused = true;
    constructor() {
      holders.push(this);
    }
    async play(): Promise<void> {
      this.paused = false;
    }
    pause(): void {
      this.paused = true;
    }
  }

  class StubHTMLMediaElement {}
  Object.defineProperty(StubHTMLMediaElement.prototype, "srcObject", { value: null, writable: true });

  const calls: SynthesisCall[] = [];
  const harness: Harness = {
    ctx,
    calls,
    latencyMs: 20,
    audible: () => ctx.starts.filter((start) => !start.loop && start.voice !== "silence"),
    voiceOrder: () => {
      const order: string[] = [];
      for (const start of harness.audible()) {
        if (order[order.length - 1] !== start.voice) order.push(start.voice);
      }
      return order;
    },
    sessionHolderPaused: () => holders.every((holder) => holder.paused),
    restore: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete globals[key];
        else globals[key] = value;
      }
    },
  };

  set("AudioContext", function AudioContextStub() {
    return ctx;
  });
  set("Audio", StubAudio);
  set("MediaStream", class {});
  set("HTMLMediaElement", StubHTMLMediaElement);
  set("document", {
    visibilityState: "visible",
    addEventListener() {},
    removeEventListener() {},
  });
  set("window", globals.window ?? { AudioContext: globals.AudioContext });
  (globals.window as Record<string, unknown>).AudioContext = globals.AudioContext;
  set("URL", globals.URL);
  set("fetch", (_url: string, init?: { body?: string }) => {
    // The voice list goes through fetch too, and has no body.
    if (!init?.body) return Promise.resolve({ ok: true, json: async () => [] });
    const body = JSON.parse(init.body) as { text: string; voice: string; rate: number };
    const payload = timePassage(body.text, amplitudeFor(body.voice));
    const audio = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    let settle!: () => void;
    let fail!: () => void;
    const response = new Promise<unknown>((resolve, reject) => {
      settle = () => {
        if (call.settled) return;
        call.settled = true;
        resolve({ ok: true, json: async () => ({ audio, words: payload.words }) });
      };
      fail = () => {
        if (call.settled) return;
        call.settled = true;
        reject(new Error("stub failure"));
      };
    });
    const call: SynthesisCall = { text: body.text, voice: body.voice, rate: body.rate, settle, fail, settled: false };
    calls.push(call);
    if (harness.latencyMs !== null) setTimeout(settle, harness.latencyMs);
    return response;
  });

  return harness;
}
