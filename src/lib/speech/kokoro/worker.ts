/// <reference lib="webworker" />
/**
 * The offline voice, in its own thread.
 *
 * Loads the Kokoro model once, turns sentences into clips, places the words
 * in each clip, and keeps every clip it makes in the store so a sentence is
 * never rendered twice. Requests arrive at two priorities: "now" is a
 * passage the reader is waiting on, "ahead" is rendering for later, and an
 * "ahead" request is only taken when nothing is waiting now. One sentence is
 * synthesised at a time: the model is not reentrant, and on a phone it is
 * the whole CPU anyway.
 */

import { KokoroTTS, env as kokoroEnv } from "kokoro-js";
import { phonemize } from "phonemizer";
import { alignClip, splitLongSentence, tokenize, type AlignedWord, type PhonemeCount } from "../offline/align";
import { clipKey, MODEL_ID, SAMPLE_RATE, type ClipRequest, type FromWorker, type ModelChoice, type ToWorker } from "../offline/protocol";
import { ClipStore } from "../offline/store";

declare const self: DedicatedWorkerGlobalScope;

const post = (message: FromWorker, transfer: Transferable[] = []) => self.postMessage(message, transfer);

let tts: KokoroTTS | null = null;
let loading: Promise<KokoroTTS> | null = null;
const store = new ClipStore();

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

function load(choice: ModelChoice): Promise<KokoroTTS> {
  if (tts) return Promise.resolve(tts);
  if (loading) return loading;
  // The runtime's WebAssembly comes from our own origin, where the service
  // worker can keep it; left alone, transformers.js fetches it from a CDN
  // that is not there when the connection is not.
  kokoroEnv.wasmPaths = choice.wasmPaths;
  const totals = new Map<string, { loaded: number; total: number }>();
  loading = KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: choice.dtype,
    device: choice.backend,
    progress_callback: (event: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (event.status !== "progress" || !event.file) return;
      totals.set(event.file, { loaded: event.loaded ?? 0, total: event.total ?? 0 });
      let loaded = 0;
      let total = 0;
      for (const entry of totals.values()) {
        loaded += entry.loaded;
        total += entry.total;
      }
      post({ type: "progress", loaded, total });
    },
  }).then(
    (model) => {
      tts = model;
      post({ type: "ready", choice });
      void pump();
      return model;
    },
    (error: unknown) => {
      loading = null;
      post({ type: "failed", message: error instanceof Error ? error.message : String(error), choice });
      throw error;
    },
  );
  return loading;
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
    `[kokoro] ${request.priority} ${cached ? "stored" : "rendered"} ${Math.round(durationMs)}ms audio in ${tookMs}ms: ${request.text.slice(0, 40)}`,
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
        const pcm = stored.pcm.slice(0);
        post({ type: "clip", id: request.id, pcm, durationMs: stored.durationMs, words: stored.words, cached: true, tookMs }, [pcm]);
      }
      return;
    }
    if (!tts && !loading) throw new Error("The offline voice has not been loaded.");
    const model = await (loading ?? Promise.resolve(tts!));
    post({ type: "working", id: request.id, text: request.text.slice(0, 48) });
    const { pcm, durationMs, words } = await render(model, request);
    const tookMs = Date.now() - began;
    note(request, false, durationMs, tookMs);
    void store.put({ key, pcm, durationMs, words, bytes: pcm.byteLength, at: Date.now() });
    if (request.storeOnly) post({ type: "clip", id: request.id, durationMs, words, cached: false, tookMs });
    else {
      const copy = pcm.slice(0);
      post({ type: "clip", id: request.id, pcm: copy, durationMs, words, cached: false, tookMs }, [copy]);
    }
  } catch (error) {
    post({ type: "clip-failed", id: request.id, message: error instanceof Error ? error.message : String(error) });
  }
}

/** Kokoro's `speed` is a plain multiplier on its duration predictor; past
 *  about twice normal the output degrades, so the fastest reader settings
 *  are held there. */
function speedFor(rate: number): number {
  return Math.min(2, Math.max(0.5, rate));
}

const phonemeCache = new Map<string, PhonemeCount>();

/** How many phonemes a word has, by the same phonemiser the model uses. */
async function phonemeCount(word: string, lang: string): Promise<PhonemeCount> {
  const bare = word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!bare) return 0;
  const cacheKey = `${lang} ${bare.toLowerCase()}`;
  const hit = phonemeCache.get(cacheKey);
  if (hit !== undefined) return hit;
  let count: PhonemeCount = null;
  try {
    const result = await phonemize(bare, lang);
    const joined = result.join("");
    // Stress and length marks are not sounds, and a tie bar joins two.
    count = [...joined.replace(/[ˈˌː͡\s]/g, "")].length || null;
  } catch {
    count = null;
  }
  if (phonemeCache.size > 20000) phonemeCache.clear();
  phonemeCache.set(cacheKey, count);
  return count;
}

async function render(
  model: KokoroTTS,
  request: ClipRequest,
): Promise<{ pcm: ArrayBuffer; durationMs: number; words: AlignedWord[] }> {
  const voice = request.voice as Parameters<KokoroTTS["generate"]>[1] extends { voice?: infer V } ? V : never;
  const lang = request.voice.startsWith("b") ? "en" : "en-us";
  const speed = speedFor(request.rate);
  const chunks = splitLongSentence(request.text);
  const pieces: { samples: Float32Array; words: AlignedWord[] }[] = [];

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    if (!tokens.some((token) => /[\p{L}\p{N}]/u.test(token.text))) {
      // Nothing to say — a row of asterisks, a lone dash. A beat of silence
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
    const audio = await model.generate(chunk.text, { voice, speed });
    const samples = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
    const rate = audio.sampling_rate || SAMPLE_RATE;
    const phonemes = await Promise.all(tokens.map((token) => phonemeCount(token.text, lang)));
    const { start, end, words } = alignClip(chunk.text, samples, rate, phonemes);
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

/** Linear resampling, for a model build that does not speak at 24 kHz. The
 *  published one does, so this is insurance rather than a path in use. */
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
