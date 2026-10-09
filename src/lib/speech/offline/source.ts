/**
 * An offline voice, as a source for the passage engine.
 *
 * A model that runs in the browser is slower than speech on a phone's CPU,
 * so this source never leans on synthesising a sentence at the moment it is
 * needed: every sentence the player says it is heading for is rendered
 * ahead, in a worker, into the clip store, and a passage is assembled from
 * clips that are already there. Where the model runs faster than speech the
 * same arrangement simply runs well ahead.
 *
 * Which model is the adapter's business: Kokoro (`kokoro/`) where it runs,
 * Piper (`piper/`) everywhere, WebKit included. Everything here — the
 * queue, the store, the watchdog, the chapter being prepared, what the
 * picker is told — is the same for both. The model is downloaded on first
 * use, not on page load, and only once: the browser keeps its files in the
 * Cache API, where the service worker cannot see them but does not need to.
 */

import type { EngineVoice } from "../engine";
import type { PassageInput, PassageSentence } from "../edge/passage";
import { DEFAULT_TIGHTEN } from "../edge/tighten";
import type { PassageRequest, SynthesisSource, SynthesisedAudio, TimedWord } from "../passageEngine";
import type { AlignedWord } from "./align";
import { clipKey, SAMPLE_RATE, type Backend, type ClipResult, type FromWorker, type ModelChoice, type ToWorker } from "./protocol";

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
  /** A chapter being rendered in full at the reader's request, or the one
   *  just finished. Null when nothing was asked for. */
  preparing: { done: number; total: number; active: boolean } | null;
  /** The last few things the worker did, newest last, in plain words: what
   *  it is rendering, how long each sentence took against the speech it
   *  made. Shown in the voice sheet so a reader on a device we cannot see
   *  can say what happened. */
  events: string[];
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

/**
 * What differs between one model and another: its voices, whether this
 * browser can run it, how its backend is chosen, where its files are and
 * whether they are already here. The worker it creates speaks the protocol
 * in `protocol.ts`.
 */
export interface OfflineModelAdapter {
  /** The engine id reported upwards, and the prefix of its voice ids. */
  readonly id: string;
  readonly prefix: string;
  readonly failureMessage: string;
  voices(): EngineVoice[];
  /** Whether this model runs in this browser at all. The source adds the
   *  general requirements (a worker, WebAssembly, IndexedDB). */
  supported(): boolean;
  /** Backend, model file and paths for this device, for `voice` where the
   *  model keeps one file per voice. */
  chooseBackend(voice: string | null): Promise<ModelChoice>;
  /** Whether the files `choice` needs are already in the browser's cache. */
  isDownloaded(choice: ModelChoice): Promise<boolean>;
  /** How large a download `choice` means, for the reader's benefit. */
  downloadBytes(choice: ModelChoice): number;
  /** One file per voice: a change of voice is another download. */
  readonly perVoice: boolean;
  createWorker(): Worker;
  /** Optional. Another choice to try when `choice` failed to load, or null
   *  to give up. The adapter remembers what it must. */
  fallback?(choice: ModelChoice): ModelChoice | null;
  /** Optional. `choice` wedged after loading; remember so it is not tried again. */
  noteStall?(choice: ModelChoice): void;
}

interface Waiting {
  resolve: (result: ClipResult) => void;
  reject: (error: Error) => void;
  key: string;
  priority: "now" | "ahead";
}

/** A whole chapter asked for ahead of time; see `prepareAll`. */
interface PrepareJob {
  keys: Set<string>;
  done: Set<string>;
}

export class OfflineModelSource implements SynthesisSource {
  readonly id: string;
  readonly prefix: string;
  readonly budgets = PASSAGE_BUDGETS;
  readonly tighten = false;
  /** Enough sentences to fill the render-ahead horizon on a wordy page. */
  readonly lookahead = 400;
  readonly failureMessage: string;

  private worker: Worker | null = null;
  private choice: ModelChoice | null = null;
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  /** Clips known to be in the store, so render-ahead never asks twice. */
  private readonly stored = new Set<string>();
  /** Render-ahead requests in flight, by clip key. */
  private readonly aheadInFlight = new Map<string, number>();
  private readonly listeners = new Set<(state: OfflineVoiceState) => void>();
  private job: PrepareJob | null = null;
  private readonly storedQueries = new Map<number, (keys: Set<string>) => void>();
  /** When the worker last said anything, and the watchdog that reads it. */
  private lastHeard = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private state: OfflineVoiceState = {
    status: "idle",
    progress: 0,
    downloadBytes: 0,
    backend: null,
    pending: 0,
    downloaded: false,
    error: null,
    preparing: null,
    events: [],
  };

  constructor(private readonly adapter: OfflineModelAdapter) {
    this.id = adapter.id;
    this.prefix = adapter.prefix;
    this.failureMessage = adapter.failureMessage;
    if (typeof window !== "undefined" && this.supported()) {
      void adapter.chooseBackend(null).then(async (choice) => {
        const downloaded = await adapter.isDownloaded(choice);
        this.update({ downloaded, downloadBytes: adapter.downloadBytes(choice) });
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

  private static readonly EVENTS_KEPT = 6;

  private event(line: string): void {
    const stamp = new Date().toLocaleTimeString(undefined, { hour12: false });
    const events = [...this.state.events, `${stamp}  ${line}`].slice(-OfflineModelSource.EVENTS_KEPT);
    this.update({ events });
  }

  supported(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof Worker !== "undefined" &&
      typeof WebAssembly !== "undefined" &&
      typeof indexedDB !== "undefined" &&
      this.adapter.supported()
    );
  }

  async loadVoices(): Promise<EngineVoice[]> {
    return this.listVoicesSync();
  }

  listVoicesSync(): EngineVoice[] {
    return this.supported() ? this.adapter.voices() : [];
  }

  /** Begin downloading and loading the model, if that has not happened. The
   *  picker calls this the moment an offline voice is chosen, so the wait is
   *  spent before play is pressed rather than after. `voice` is the bare
   *  voice id, prefix removed, for a model with one file per voice. */
  download(voice: string | null = null): void {
    void this.ensureLoaded(voice).catch(() => {});
  }

  private ensureLoaded(voice: string | null): Promise<void> {
    if (this.worker) {
      // The worker is up; a model with one file per voice may still have
      // this voice to fetch, and the picker should see that happen.
      if (this.adapter.perVoice && voice && this.choice && voice !== this.choice.voice) {
        return this.adapter.chooseBackend(voice).then(async (choice) => {
          this.choice = choice;
          const downloaded = await this.adapter.isDownloaded(choice);
          this.update({ status: "loading", progress: downloaded ? 1 : 0, downloaded, downloadBytes: this.adapter.downloadBytes(choice) });
          this.event(downloaded ? `Loading the ${voice} voice` : `Downloading the ${voice} voice`);
          this.send({ type: "load", choice });
        });
      }
      return Promise.resolve();
    }
    if (!this.supported()) return Promise.reject(new Error("This browser can't run the offline voice."));
    this.update({ status: "loading", progress: 0, error: null });
    const worker = this.adapter.createWorker();
    this.worker = worker;
    this.lastHeard = Date.now();
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      this.lastHeard = Date.now();
      this.receive(event.data);
    };
    worker.onerror = (event) => {
      this.failed(event.message || "The offline voice stopped unexpectedly.");
    };
    this.startWatchdog();
    return this.adapter.chooseBackend(voice).then(async (choice) => {
      if (this.worker !== worker) return;
      this.choice = choice;
      const downloaded = await this.adapter.isDownloaded(choice);
      this.update({ backend: choice.backend, downloaded, downloadBytes: this.adapter.downloadBytes(choice) });
      this.event(
        `Loading the ${choice.dtype} model${choice.voice ? ` (${choice.voice})` : ""} on ${choice.backend === "webgpu" ? "the GPU (WebGPU)" : "the CPU (WebAssembly)"}`,
      );
      this.send({ type: "load", choice });
    });
  }

  private send(message: ToWorker): void {
    this.worker?.postMessage(message);
  }

  /** A worker the browser has killed for memory, or a backend that has
   *  wedged, says nothing at all: no error, no result. So silence is the
   *  signal. While the reader is waiting on something, the worker must have
   *  spoken within this long — a download reports progress, a render says
   *  when it begins, and no single sentence takes this long on any device
   *  the model is usable on. */
  private static readonly STALL_MS = 120_000;

  private startWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      const waiting = this.state.status === "loading" || this.state.pending > 0 || this.aheadInFlight.size > 0;
      if (!waiting) {
        this.lastHeard = Date.now();
        return;
      }
      if (Date.now() - this.lastHeard < OfflineModelSource.STALL_MS) return;
      if (this.choice) this.adapter.noteStall?.(this.choice);
      this.failed(
        this.state.status === "loading"
          ? "The offline voice stopped downloading. Check the connection and pick it again to retry."
          : "The offline voice stopped responding on this device. Pick another voice, or pick it again to retry.",
      );
    }, 5000);
  }

  private receive(message: FromWorker): void {
    switch (message.type) {
      case "working":
        this.event(`Rendering: ${message.text}…`);
        return;
      case "progress":
        // A model with one file per voice downloads again after it was
        // ready, when the reader picks another of its voices.
        if (message.total > 0) {
          this.update({ status: "loading", progress: Math.min(1, message.loaded / message.total), downloadBytes: message.total });
        }
        return;
      case "ready":
        this.update({ status: "ready", progress: 1, downloaded: true, error: null });
        this.event("Model ready");
        return;
      case "failed": {
        // A backend can fail on a device that claims to offer it; the
        // adapter may have another to try, and remembers which to avoid.
        const fallback = this.adapter.fallback?.(message.choice) ?? null;
        if (fallback) {
          this.choice = fallback;
          this.update({ backend: fallback.backend, progress: 0, downloadBytes: this.adapter.downloadBytes(fallback) });
          void this.adapter.isDownloaded(fallback).then((downloaded) => this.update({ downloaded }));
          this.event(`Trying again on ${fallback.backend === "webgpu" ? "the GPU" : "the CPU"}`);
          this.send({ type: "load", choice: fallback });
          return;
        }
        this.failed(message.message);
        return;
      }
      case "clip": {
        const waiting = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (!waiting) return;
        this.stored.add(waiting.key);
        if (waiting.priority === "ahead") this.aheadInFlight.delete(waiting.key);
        else this.update({ pending: Math.max(0, this.state.pending - 1) });
        this.noteStored(waiting.key);
        if (!message.cached) {
          this.event(
            `Rendered ${(message.durationMs / 1000).toFixed(1)} s of speech in ${(message.tookMs / 1000).toFixed(1)} s` +
              (message.tookMs > 0 ? ` (${(message.durationMs / message.tookMs).toFixed(2)}× real time)` : ""),
          );
        }
        waiting.resolve(message);
        return;
      }
      case "clip-failed": {
        const waiting = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (!waiting) return;
        if (waiting.priority === "ahead") this.aheadInFlight.delete(waiting.key);
        else this.update({ pending: Math.max(0, this.state.pending - 1) });
        this.event(`A sentence failed: ${message.message}`);
        waiting.reject(new Error(message.message));
        return;
      }
      case "stored": {
        const resolve = this.storedQueries.get(message.id);
        this.storedQueries.delete(message.id);
        resolve?.(new Set(message.keys));
        return;
      }
    }
  }

  /** A clip the chapter being prepared was waiting on has landed. */
  private noteStored(key: string): void {
    const job = this.job;
    if (!job || !job.keys.has(key) || job.done.has(key)) return;
    job.done.add(key);
    const done = job.done.size;
    const total = job.keys.size;
    this.update({ preparing: { done, total, active: done < total } });
  }

  private whichStored(keys: string[]): Promise<Set<string>> {
    const id = this.nextId++;
    return new Promise<Set<string>>((resolve) => {
      this.storedQueries.set(id, resolve);
      this.send({ type: "stored", id, keys });
    });
  }

  /**
   * Render a whole chapter now, at the reader's request, so it can be read
   * with no connection and with no pause for thought. Everything already in
   * the store counts straight away; the rest is queued behind anything the
   * reader is waiting on, and `preparing` says how far along it is.
   */
  prepareAll(texts: string[], voice: string, rate: number): void {
    if (!this.supported()) return;
    void this.ensureLoaded(voice).catch(() => {});
    this.stopPreparing();
    const wanted = new Map<string, string>();
    for (const raw of texts) {
      const text = raw.trim();
      if (text) wanted.set(clipKey(voice, rate, text), text);
    }
    if (!wanted.size) return;
    const job: PrepareJob = { keys: new Set(wanted.keys()), done: new Set() };
    this.job = job;
    this.update({ preparing: { done: 0, total: job.keys.size, active: true } });
    void this.whichStored([...wanted.keys()]).then((present) => {
      if (this.job !== job) return;
      for (const key of present) {
        this.stored.add(key);
        job.done.add(key);
      }
      this.update({ preparing: { done: job.done.size, total: job.keys.size, active: job.done.size < job.keys.size } });
      for (const [key, text] of wanted) {
        if (present.has(key) || this.aheadInFlight.has(key)) continue;
        void this.requestClip(text, voice, rate, "ahead", true).catch(() => {});
      }
    });
  }

  /** Call off a chapter being prepared; what is already rendered stays. */
  stopPreparing(): void {
    const job = this.job;
    this.job = null;
    if (!job) return;
    const stale: number[] = [];
    for (const [key, id] of this.aheadInFlight) {
      if (job.keys.has(key) && !job.done.has(key)) {
        this.aheadInFlight.delete(key);
        if (id >= 0) {
          stale.push(id);
          this.waiting.delete(id);
        }
      }
    }
    if (stale.length) this.send({ type: "cancel", ids: stale });
    this.update({ preparing: null });
  }

  private failed(message: string): void {
    this.job = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.update({ status: "failed", error: message, pending: 0, preparing: null });
    this.event(`Failed: ${message}`);
    for (const waiting of this.waiting.values()) waiting.reject(new Error(message));
    this.waiting.clear();
    this.aheadInFlight.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  /** How long to wait for the first sound: minutes while the model is still
   *  arriving, with progress on screen, and afterwards longer than the
   *  watchdog, which is the real detector of a voice that has died. A phone
   *  CPU may need the better part of a minute for an opening passage, and
   *  giving up at thirty seconds restarted that render three times over and
   *  then blamed the voice for making no sound. */
  startBudgetMs(): number {
    if (this.state.status !== "ready") return 10 * 60 * 1000;
    return OfflineModelSource.STALL_MS + 30_000;
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
    await this.ensureLoaded(request.voice);
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
    void this.ensureLoaded(voice).catch(() => {});
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
      // A chapter being prepared in full is not stale for having fallen
      // behind the reader's window; that is the point of it.
      if (!wanted.has(key) && !this.job?.keys.has(key)) {
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
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
    this.aheadInFlight.clear();
    this.storedQueries.clear();
    this.job = null;
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
