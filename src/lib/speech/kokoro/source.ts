/**
 * The offline voice, as a source for the passage engine.
 *
 * Kokoro is an 82-million-parameter model that runs in the browser. Even
 * quantised it is slower than speech on a phone's CPU, so this source never
 * leans on synthesising a sentence at the moment it is needed: every
 * sentence the player says it is heading for is rendered ahead, in the
 * worker, into the clip store, and a passage is assembled from clips that
 * are already there. Where the device has a GPU the model runs several
 * times faster than speech and the same arrangement simply runs well ahead.
 *
 * The model is downloaded on first use, not on page load, and only once:
 * the browser keeps its files in the Cache API, where the service worker
 * cannot see them but does not need to.
 */

import type { EngineVoice } from "../engine";
import type { PassageInput, PassageSentence } from "../edge/passage";
import { DEFAULT_TIGHTEN } from "../edge/tighten";
import type { PassageRequest, SynthesisSource, SynthesisedAudio, TimedWord } from "../passageEngine";
import type { AlignedWord } from "./align";
import {
  clipKey,
  MODEL_BYTES,
  MODEL_ID,
  SAMPLE_RATE,
  type Backend,
  type ClipResult,
  type Dtype,
  type FromWorker,
  type ModelChoice,
  type ToWorker,
} from "./protocol";
import { kokoroEngineVoices, KOKORO_PREFIX } from "./voices";

export type OfflineVoiceStatus = "idle" | "loading" | "ready" | "failed";

export interface OfflineVoiceState {
  status: OfflineVoiceStatus;
  /** 0..1 while loading; the download is nearly all of it. */
  progress: number;
  /** What the download will cost, once the backend is chosen. */
  downloadBytes: number;
  backend: Backend | null;
  /** Sentences the reader is waiting on right now. */
  pending: number;
  /** True once the model's files are known to be on this device, so the
   *  voice can be relied on with no connection. */
  downloaded: boolean;
  error: string | null;
}

/** How far ahead of the reader to render, in characters of text: about
 *  fifteen minutes of listening. Far enough that a phone slower than speech
 *  has a cushion, near enough that the worker goes quiet, and the battery
 *  with it, once the cushion is full. */
const AHEAD_CHARS = 14_000;

/** Passages stay short: a passage is only ready when its last sentence is,
 *  and a sentence not yet in the store costs seconds. The first is one
 *  sentence or so, so the first sound comes as soon as it can. */
const PASSAGE_BUDGETS = [140, 320, 600];

const REMEMBERED_KEY = "aloud.offlineVoice.v1";

/** The onnxruntime files are copied under the transformers.js version they
 *  came with (scripts/ort-assets.mjs), so a new version is a new path and
 *  the service worker can keep them for good. */
const WASM_PATHS = `/ort/${process.env.NEXT_PUBLIC_TRANSFORMERS_VERSION ?? "unknown"}/`;

interface Remembered {
  /** A backend that failed here; not tried again. */
  avoid?: Backend;
}

function readRemembered(): Remembered {
  try {
    return (JSON.parse(localStorage.getItem(REMEMBERED_KEY) ?? "{}") as Remembered) ?? {};
  } catch {
    return {};
  }
}

function remember(update: Remembered): void {
  try {
    localStorage.setItem(REMEMBERED_KEY, JSON.stringify({ ...readRemembered(), ...update }));
  } catch {
    /* private mode */
  }
}

function modelFile(dtype: Dtype): string {
  return `https://huggingface.co/${MODEL_ID}/resolve/main/onnx/model_${dtype === "q8" ? "quantized" : dtype}.onnx`;
}

/** Whether a model's weights are already in the browser's cache, where
 *  transformers.js keeps them. Looked up directly so the question can be
 *  answered without waking the worker. */
async function isDownloaded(dtype: Dtype): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const cache = await caches.open("transformers-cache");
    return !!(await cache.match(modelFile(dtype)));
  } catch {
    return false;
  }
}

/** The GPU path needs WebGPU with 16-bit floats; everything else runs the
 *  8-bit model on the CPU. */
async function chooseBackend(): Promise<ModelChoice> {
  const avoid = readRemembered().avoid;
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ features: Set<string> } | null> } }).gpu;
  if (avoid !== "webgpu" && gpu) {
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter?.features.has("shader-f16")) return { backend: "webgpu", dtype: "fp16", wasmPaths: WASM_PATHS };
    } catch {
      /* no usable adapter */
    }
  }
  return { backend: "wasm", dtype: "q8", wasmPaths: WASM_PATHS };
}

interface Waiting {
  resolve: (result: ClipResult) => void;
  reject: (error: Error) => void;
  key: string;
  priority: "now" | "ahead";
}

export class KokoroSource implements SynthesisSource {
  readonly id = "kokoro";
  readonly prefix = KOKORO_PREFIX;
  readonly budgets = PASSAGE_BUDGETS;
  readonly tighten = false;
  /** Enough sentences to fill the render-ahead horizon on a wordy page. */
  readonly lookahead = 400;
  readonly failureMessage = "The offline voice couldn't read that. Press play to try again.";

  private worker: Worker | null = null;
  private choice: ModelChoice | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  /** Clips known to be in the store, so render-ahead never asks twice. */
  private readonly stored = new Set<string>();
  /** Render-ahead requests in flight, by clip key. */
  private readonly aheadInFlight = new Map<string, number>();
  private readonly listeners = new Set<(state: OfflineVoiceState) => void>();
  private state: OfflineVoiceState = {
    status: "idle",
    progress: 0,
    downloadBytes: MODEL_BYTES.q8,
    backend: null,
    pending: 0,
    downloaded: false,
    error: null,
  };

  constructor() {
    if (typeof window !== "undefined") {
      void chooseBackend().then(async (choice) => {
        const downloaded = await isDownloaded(choice.dtype);
        this.update({ downloaded, downloadBytes: MODEL_BYTES[choice.dtype] });
      });
    }
  }

  /* ------------------------------------------------------------- state */

  get current(): OfflineVoiceState {
    return this.state;
  }

  subscribe(listener: (state: OfflineVoiceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<OfflineVoiceState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  supported(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof Worker !== "undefined" &&
      typeof WebAssembly !== "undefined" &&
      typeof indexedDB !== "undefined"
    );
  }

  async loadVoices(): Promise<EngineVoice[]> {
    return this.supported() ? kokoroEngineVoices() : [];
  }

  /** Begin downloading and loading the model, if that has not happened. The
   *  picker calls this the moment an offline voice is chosen, so the wait is
   *  spent before play is pressed rather than after. */
  download(): void {
    void this.ensureLoaded();
  }

  private ensureLoaded(): Promise<void> {
    if (this.worker) return Promise.resolve();
    if (!this.supported()) return Promise.reject(new Error("This browser can't run the offline voice."));
    this.update({ status: "loading", progress: 0, error: null });
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    worker.onmessage = (event: MessageEvent<FromWorker>) => this.receive(event.data);
    worker.onerror = (event) => {
      this.failed(event.message || "The offline voice stopped unexpectedly.");
    };
    return chooseBackend().then((choice) => {
      if (this.worker !== worker) return;
      this.choice = choice;
      this.update({ backend: choice.backend, downloadBytes: MODEL_BYTES[choice.dtype] });
      this.send({ type: "load", choice });
    });
  }

  private send(message: ToWorker): void {
    this.worker?.postMessage(message);
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case "progress":
        if (this.state.status === "loading" && message.total > 0) {
          this.update({ progress: Math.min(1, message.loaded / message.total), downloadBytes: message.total });
        }
        return;
      case "ready":
        this.update({ status: "ready", progress: 1, downloaded: true, error: null });
        return;
      case "failed":
        // The GPU path is the one that can fail on a device that claims to
        // offer it. Remember, and read with the CPU model from here on.
        if (message.choice.backend === "webgpu") {
          remember({ avoid: "webgpu" });
          const choice: ModelChoice = { backend: "wasm", dtype: "q8", wasmPaths: WASM_PATHS };
          this.choice = choice;
          this.update({ backend: "wasm", progress: 0, downloadBytes: MODEL_BYTES.q8 });
          void isDownloaded("q8").then((downloaded) => this.update({ downloaded }));
          this.send({ type: "load", choice });
          return;
        }
        this.failed(message.message);
        return;
      case "clip": {
        const waiting = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (!waiting) return;
        this.stored.add(waiting.key);
        if (waiting.priority === "ahead") this.aheadInFlight.delete(waiting.key);
        else this.update({ pending: Math.max(0, this.state.pending - 1) });
        waiting.resolve(message);
        return;
      }
      case "clip-failed": {
        const waiting = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (!waiting) return;
        if (waiting.priority === "ahead") this.aheadInFlight.delete(waiting.key);
        else this.update({ pending: Math.max(0, this.state.pending - 1) });
        waiting.reject(new Error(message.message));
        return;
      }
      case "stored":
        return;
    }
  }

  private failed(message: string): void {
    this.update({ status: "failed", error: message, pending: 0 });
    for (const waiting of this.waiting.values()) waiting.reject(new Error(message));
    this.waiting.clear();
    this.aheadInFlight.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  /** How long to wait for the first sound: minutes while the model is still
   *  arriving, with progress on screen, and long enough afterwards for a
   *  phone slower than speech to render the opening sentence. */
  startBudgetMs(): number {
    if (this.state.status !== "ready") return 10 * 60 * 1000;
    return 30_000;
  }

  /* -------------------------------------------------------------- clips */

  private requestClip(text: string, voice: string, rate: number, priority: "now" | "ahead", storeOnly: boolean): Promise<ClipResult> {
    const key = clipKey(voice, rate, text);
    const id = this.nextId++;
    return new Promise<ClipResult>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, key, priority });
      if (priority === "ahead") this.aheadInFlight.set(key, id);
      else this.update({ pending: this.state.pending + 1 });
      this.send({ type: "clip", id, text, voice, rate, priority, storeOnly });
    });
  }

  async synthesize(request: PassageRequest, ctx: BaseAudioContext, signal: AbortSignal): Promise<SynthesisedAudio> {
    await this.ensureLoaded();
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    // A passage the reader is waiting on goes to the front of the worker's
    // queue, ahead of any rendering for later.
    const clips = await Promise.all(
      request.sentences.map((sentence) => this.requestClip(sentence.text, request.voice, request.rate, "now", false)),
    );
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    return assemble(ctx, request.sentences, clips);
  }

  /**
   * The sentences the reader is heading for, in order. Everything within the
   * horizon that is not in the store and not already asked for is queued at
   * the back of the worker's queue; anything in flight that has fallen out
   * of the window, because the reader jumped elsewhere, is cancelled.
   */
  offer(sentences: PassageInput[], voice: string, rate: number): void {
    if (!this.supported()) return;
    void this.ensureLoaded();
    const wanted = new Map<string, string>();
    let chars = 0;
    for (const sentence of sentences) {
      const text = sentence.text.trim();
      if (!text) continue;
      chars += text.length;
      if (chars > AHEAD_CHARS) break;
      wanted.set(clipKey(voice, rate, text), text);
    }
    const stale: number[] = [];
    for (const [key, id] of this.aheadInFlight) {
      if (!wanted.has(key)) {
        this.aheadInFlight.delete(key);
        if (id < 0) continue; // reserved but never posted
        stale.push(id);
        this.waiting.delete(id);
      }
    }
    if (stale.length) this.send({ type: "cancel", ids: stale });
    const fresh = [...wanted].filter(([key]) => !this.stored.has(key) && !this.aheadInFlight.has(key));
    if (!fresh.length) return;
    // Reserve the keys now, so a second offer in the same turn does not ask
    // twice, but post after the turn: the passage the reader is waiting on
    // is requested from this same `prepare` call a moment later and has to
    // reach the worker first.
    for (const [key] of fresh) this.aheadInFlight.set(key, -1);
    setTimeout(() => {
      for (const [key, text] of fresh) {
        if (this.aheadInFlight.get(key) !== -1) continue;
        this.aheadInFlight.delete(key);
        void this.requestClip(text, voice, rate, "ahead", true).catch(() => {});
      }
    }, 0);
  }

  destroy(): void {
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
    this.aheadInFlight.clear();
  }
}

/** Silence placed after a sentence inside a passage, by what follows it.
 *  The same figures the cloud voices are trimmed to, so switching voice does
 *  not change the pace of the reading. */
function gapAfter(sentence: PassageSentence): number {
  return sentence.endsParagraph ? DEFAULT_TIGHTEN.paragraphPauseMs : DEFAULT_TIGHTEN.sentencePauseMs;
}

/** Joins a passage's clips into one buffer, each sentence's words re-based
 *  onto the passage, which is how the engine locates sentences in it. */
export function assemble(ctx: BaseAudioContext, sentences: PassageSentence[], clips: ClipResult[]): SynthesisedAudio {
  let frames = 0;
  clips.forEach((clip, i) => {
    frames += clip.pcm ? clip.pcm.byteLength / 2 : 0;
    if (i < clips.length - 1) frames += Math.round((SAMPLE_RATE * gapAfter(sentences[i])) / 1000);
  });
  const buffer = ctx.createBuffer(1, Math.max(1, frames), SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  const words: TimedWord[] = [];
  let cursor = 0;
  clips.forEach((clip, i) => {
    const sentence = sentences[i];
    const offsetMs = (cursor / SAMPLE_RATE) * 1000;
    if (clip.pcm) {
      const pcm = new Int16Array(clip.pcm);
      for (let j = 0; j < pcm.length; j++) channel[cursor + j] = pcm[j] / 0x8000;
      cursor += pcm.length;
    }
    for (const word of clip.words as AlignedWord[]) {
      words.push({
        charIndex: sentence.start + word.charIndex,
        charLength: word.charLength,
        offsetMs: Math.round(offsetMs + word.offsetMs),
        durationMs: word.durationMs,
      });
    }
    if (i < clips.length - 1) cursor += Math.round((SAMPLE_RATE * gapAfter(sentence)) / 1000);
  });
  return { buffer, words };
}

let singleton: KokoroSource | null = null;

/** One model per page: it is far too large to load twice. */
export function getOfflineVoice(): KokoroSource {
  if (!singleton) singleton = new KokoroSource();
  return singleton;
}
