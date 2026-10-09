/// <reference lib="webworker" />
/**
 * The Piper offline voice, in its own thread.
 *
 * Same job and same protocol as the Kokoro worker, on a model that runs where
 * Kokoro does not: WebKit. Each voice is one small ONNX file, loaded when a
 * clip first asks for it. Requests arrive at two priorities, "now" for a
 * passage the reader is waiting on and "ahead" for later, and one sentence is
 * synthesised at a time.
 */

// The plain WebAssembly build, on purpose. The jsep (WebGPU) builds hang
// WebKit (onnxruntime issue 26827), so the exports map must resolve to
// ort.wasm.bundle.min.mjs and nothing else. If a bundler resolves it wrongly,
// import "onnxruntime-web/dist/ort.wasm.bundle.min.mjs" instead.
import * as ort from "onnxruntime-web/wasm";
import { alignClip, splitLongSentence, tokenize, type AlignedWord } from "../offline/align";
import { clipKey, SAMPLE_RATE, type ClipRequest, type FromWorker, type ModelChoice, type ToWorker } from "../offline/protocol";
import { encodeAdpcm } from "../offline/adpcm";
import { ClipStore } from "../offline/store";
import { PIPER_PREFIX, piperModelUrls } from "./voices";

declare const self: DedicatedWorkerGlobalScope;

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);

interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
}

interface Voice {
  session: ort.InferenceSession;
  config: PiperConfig;
}

const voices = new Map<string, Voice>();
const loadingVoices = new Map<string, Promise<Voice>>();
const store = new ClipStore();
let piperPaths = "";
let configured = false;
let defaultVoice = "";

const now: ClipRequest[] = [];
const ahead: ClipRequest[] = [];
let working = false;
let pumpTimer: ReturnType<typeof setTimeout> | null = null;
/** When the last request the reader was waiting on was served. */
let lastNowServedAt = 0;

/** Rendering for later waits this long after anything the reader was
 *  waiting on, because the engine asks for the next passage within a few
 *  milliseconds of getting one, and a sentence started for later cannot be
 *  interrupted once the model has it. */
const QUIET_AFTER_NOW_MS = 400;

/** Silence between the pieces of a sentence too long to synthesise whole. */
const CHUNK_GAP_MS = 140;

const MODEL_CACHE = "aloud-models";

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "load":
      void load(message.choice);
      return;
    case "clip":
      (message.priority === "now" ? now : ahead).push(message);
      // Not straight away: the requests of one turn on the main thread
      // arrive together, and a passage the reader is waiting on is posted a
      // moment after the render-ahead for the sentences past it. Taken as
      // they came, the model would start on a sentence for later and the
      // reader would wait for it to finish.
      schedulePump();
      return;
    case "cancel": {
      const ids = new Set(message.ids);
      remove(now, (r) => ids.has(r.id));
      remove(ahead, (r) => ids.has(r.id));
      return;
    }
    case "drop":
      (message.priority === "now" ? now : ahead).length = 0;
      return;
    case "stored":
      void store.has(message.keys).then((present) => post({ type: "stored", id: message.id, keys: [...present] }));
      return;
  }
};

function remove<T>(list: T[], where: (item: T) => boolean): void {
  for (let i = list.length - 1; i >= 0; i--) if (where(list[i])) list.splice(i, 1);
}


function voiceId(voice: string): string {
  return voice.startsWith(PIPER_PREFIX) ? voice.slice(PIPER_PREFIX.length) : voice;
}

function load(choice: ModelChoice): Promise<Voice> {
  // The plain build is required on WebKit, and a single thread because
  // threads need cross-origin isolation the site does not have. No proxy
  // worker: this already is one.
  ort.env.wasm.wasmPaths = choice.wasmPaths;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  piperPaths = choice.piperPaths ?? piperPaths;
  configured = true;
  defaultVoice = choice.voice ? voiceId(choice.voice) : defaultVoice;
  const first = loadVoice(defaultVoice || "en_US-lessac-medium");
  first.then(
    () => {
      post({ type: "ready", choice });
      void pump();
    },
    (error: unknown) => post({ type: "failed", message: error instanceof Error ? error.message : String(error), choice }),
  );
  return first;
}

function loadVoice(id: string): Promise<Voice> {
  const loaded = voices.get(id);
  if (loaded) return Promise.resolve(loaded);
  const pending = loadingVoices.get(id);
  if (pending) return pending;
  const promise = fetchVoice(id).then(
    (voice) => {
      voices.set(id, voice);
      loadingVoices.delete(id);
      return voice;
    },
    (error: unknown) => {
      loadingVoices.delete(id);
      throw error;
    },
  );
  loadingVoices.set(id, promise);
  return promise;
}

async function cached(url: string, onBody?: (response: Response) => Promise<ArrayBuffer>): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(MODEL_CACHE);
    const hit = await cache.match(url);
    if (hit) return await hit.arrayBuffer();
  } catch {
    cache = null;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch ${url}: ${response.status}`);
  const copy = response.clone();
  const bytes = onBody ? await onBody(response) : await response.arrayBuffer();
  if (cache) {
    try {
      await cache.put(url, copy);
    } catch {
      // Storage full or blocked: the voice works this session and is
      // fetched again next time.
    }
  }
  return bytes;
}

/** Reads the body as it arrives so the page can show a download bar. */
async function withProgress(response: Response): Promise<ArrayBuffer> {
  const total = Number(response.headers.get("Content-Length")) || 0;
  if (!response.body) return response.arrayBuffer();
  if (!total) post({ type: "progress", loaded: 0, total: 0 });
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    if (total) post({ type: "progress", loaded, total });
  }
  const out = new Uint8Array(loaded);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out.buffer;
}

async function fetchVoice(id: string): Promise<Voice> {
  const urls = piperModelUrls(id);
  const [model, configBytes] = await Promise.all([cached(urls.onnx, withProgress), cached(urls.json)]);
  const config = JSON.parse(new TextDecoder().decode(configBytes)) as PiperConfig;
  const session = await ort.InferenceSession.create(new Uint8Array(model), { executionProviders: ["wasm"] });
  return { session, config };
}

type PhonemizeFactory = (options: Record<string, unknown>) => Promise<{ callMain(args: string[]): void }>;
let factory: Promise<PhonemizeFactory> | null = null;

/** piper_phonemize.js is a classic Emscripten script that defines a global,
 *  and a module worker cannot importScripts, so it is fetched and evaluated. */
function phonemizer(): Promise<PhonemizeFactory> {
  factory ??= fetch(`${piperPaths}piper_phonemize.js`)
    .then((response) => {
      if (!response.ok) throw new Error(`Could not fetch the phonemiser: ${response.status}`);
      return response.text();
    })
    .then((code) => new Function(`${code}\nreturn createPiperPhonemize;`)() as PhonemizeFactory)
    .catch((error: unknown) => {
      factory = null;
      throw error;
    });
  return factory;
}

/** A module per call, because callMain runs the program's main() once. */
async function phonemeIds(text: string, config: PiperConfig): Promise<number[]> {
  const create = await phonemizer();
  return new Promise<number[]>((resolve, reject) => {
    create({
      print: (line: string) => {
        try {
          resolve((JSON.parse(line) as { phoneme_ids: number[] }).phoneme_ids);
        } catch (error) {
          reject(error);
        }
      },
      printErr: (message: string) => reject(new Error(message)),
      locateFile: (url: string) =>
        url.endsWith(".wasm") ? `${piperPaths}piper_phonemize.wasm` : url.endsWith(".data") ? `${piperPaths}piper_phonemize.data` : url,
    }).then((module) => {
      module.callMain(["-l", config.espeak.voice, "--input", JSON.stringify([{ text }]), "--espeak_data", "/espeak-ng-data"]);
    }, reject);
  });
}

/** A larger length_scale is slower speech, so the reader's rate divides it.
 *  Past about twice normal the output degrades, so it is held there. */
function speedFor(rate: number): number {
  return Math.min(2, Math.max(0.5, rate));
}

async function synthesise(voice: Voice, text: string, rate: number): Promise<Float32Array> {
  const ids = await phonemeIds(text, voice.config);
  const { noise_scale, length_scale, noise_w } = voice.config.inference;
  const results = await voice.session.run({
    input: new ort.Tensor("int64", BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([noise_scale, length_scale / speedFor(rate), noise_w]), [3]),
  });
  return results.output.data as Float32Array;
}

function schedulePump(delayMs = 0): void {
  if (pumpTimer !== null) return;
  pumpTimer = setTimeout(() => {
    pumpTimer = null;
    void pump();
  }, delayMs);
}

async function pump(): Promise<void> {
  if (working) return;
  working = true;
  try {
    for (;;) {
      let request = now.shift();
      if (!request) {
        const sinceNow = Date.now() - lastNowServedAt;
        if (ahead.length && sinceNow < QUIET_AFTER_NOW_MS) {
          schedulePump(QUIET_AFTER_NOW_MS - sinceNow);
          break;
        }
        request = ahead.shift();
      }
      if (!request) break;
      await serve(request);
      if (request.priority === "now") lastNowServedAt = Date.now();
    }
  } finally {
    working = false;
  }
}

/** One line per clip, at debug level, so a run can be read back: which
 *  sentences came from the store, which were rendered, and how long each
 *  render took against the audio it produced. */
function note(request: ClipRequest, cached: boolean, durationMs: number, tookMs: number): void {
  console.debug(
    `[piper] ${request.priority} ${cached ? "stored" : "rendered"} ${Math.round(durationMs)}ms audio in ${tookMs}ms: ${request.text.slice(0, 40)}`,
  );
}

async function serve(request: ClipRequest): Promise<void> {
  const key = clipKey(request.voice, request.rate, request.text);
  const began = Date.now();
  try {
    const stored = await store.get(key);
    if (stored) {
      const tookMs = Date.now() - began;
      note(request, true, stored.durationMs, tookMs);
      if (request.storeOnly) post({ type: "clip", id: request.id, durationMs: stored.durationMs, words: stored.words, cached: true, tookMs });
      else {
        const adpcm = stored.adpcm.slice(0);
        post({ type: "clip", id: request.id, adpcm, samples: stored.samples, durationMs: stored.durationMs, words: stored.words, cached: true, tookMs }, [adpcm]);
      }
      return;
    }
    if (!configured) throw new Error("The offline voice has not been loaded.");
    const model = await loadVoice(voiceId(request.voice));
    post({ type: "working", id: request.id, text: request.text.slice(0, 48) });
    const { pcm, durationMs, words } = await render(model, request);
    const samples = pcm.byteLength / 2;
    const adpcm = encodeAdpcm(new Int16Array(pcm)).buffer as ArrayBuffer;
    const tookMs = Date.now() - began;
    note(request, false, durationMs, tookMs);
    void store.put({ key, adpcm, samples, durationMs, words, bytes: adpcm.byteLength, at: Date.now() });
    if (request.storeOnly) post({ type: "clip", id: request.id, durationMs, words, cached: false, tookMs });
    else {
      const copy = adpcm.slice(0);
      post({ type: "clip", id: request.id, adpcm: copy, samples, durationMs, words, cached: false, tookMs }, [copy]);
    }
  } catch (error) {
    post({ type: "clip-failed", id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

async function render(
  model: Voice,
  request: ClipRequest,
): Promise<{ pcm: ArrayBuffer; durationMs: number; words: AlignedWord[] }> {
  const chunks = splitLongSentence(request.text);
  const pieces: { samples: Float32Array; words: AlignedWord[] }[] = [];

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    if (!tokens.some((token) => /[\p{L}\p{N}]/u.test(token.text))) {
      // Nothing to say, a row of asterisks or a lone dash. A beat of silence
      // keeps the player's sense of time rather than erroring.
      const samples = new Float32Array(Math.round(SAMPLE_RATE * 0.3));
      pieces.push({
        samples,
        words: tokens.map((token) => ({
          charIndex: chunk.charIndex + token.charIndex,
          charLength: token.text.length,
          offsetMs: 0,
          durationMs: 300,
        })),
      });
      continue;
    }
    const samples = await synthesise(model, chunk.text, request.rate);
    const rate = model.config.audio.sample_rate || SAMPLE_RATE;
    // No per-word phonemes: counting them would cost a phonemiser module per
    // word, so alignment falls back to letter counts.
    const { start, end, words } = alignClip(chunk.text, samples, rate, tokens.map(() => null));
    pieces.push({
      samples: rate === SAMPLE_RATE ? samples.subarray(start, end) : resample(samples.subarray(start, end), rate),
      words: words.map((word) => ({ ...word, charIndex: word.charIndex + chunk.charIndex })),
    });
  }


  const gap = Math.round((SAMPLE_RATE * CHUNK_GAP_MS) / 1000);
  const total = pieces.reduce((sum, piece, i) => sum + piece.samples.length + (i ? gap : 0), 0);
  const pcm = new Int16Array(total);
  const words: AlignedWord[] = [];
  let cursor = 0;
  for (let i = 0; i < pieces.length; i++) {
    if (i) cursor += gap;
    const offsetMs = (cursor / SAMPLE_RATE) * 1000;
    const { samples } = pieces[i];
    for (let j = 0; j < samples.length; j++) {
      const v = Math.max(-1, Math.min(1, samples[j]));
      pcm[cursor + j] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    for (const word of pieces[i].words) words.push({ ...word, offsetMs: Math.round(word.offsetMs + offsetMs) });
    cursor += samples.length;
  }
  return { pcm: pcm.buffer, durationMs: (total / SAMPLE_RATE) * 1000, words };
}

/** Linear resampling, for a voice that does not speak at 24 kHz, which is every
 *  Piper medium voice (22.05 kHz). */
function resample(samples: Float32Array, from: number): Float32Array {
  const ratio = SAMPLE_RATE / from;
  const out = new Float32Array(Math.round(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const at = i / ratio;
    const lo = Math.floor(at);
    const hi = Math.min(samples.length - 1, lo + 1);
    out[i] = samples[lo] + (samples[hi] - samples[lo]) * (at - lo);
  }
  return out;
}
