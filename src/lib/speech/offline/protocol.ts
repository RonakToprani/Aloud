/**
 * What passes between the reader and the worker that runs the offline voice.
 *
 * The model runs in a worker because a sentence takes it anywhere from a
 * fifth of a second to several seconds, and the page must keep scrolling
 * and lighting words throughout. Audio crosses back as 16-bit samples, which
 * halves what has to be copied and is what the clip store keeps anyway.
 */

import type { AlignedWord } from "./align";

export type Backend = "webgpu" | "wasm";
export type Dtype = "fp16" | "q8" | "fp32";

/** Where the model's own files are kept: the Hugging Face hub, cached by the
 *  browser after the first download. */
export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const SAMPLE_RATE = 24000;

export interface ModelChoice {
  backend: Backend;
  dtype: Dtype;
  /** Same-origin directory holding the onnxruntime WebAssembly files. */
  wasmPaths: string;
  /** For a model with one file per voice (Piper): the voice to load now.
   *  Others are loaded as clips ask for them. */
  voice?: string;
}

/** Approximate download sizes, for the reader's benefit. */
export const MODEL_BYTES: Record<Dtype, number> = {
  fp16: 163_000_000,
  q8: 92_000_000,
  fp32: 63_000_000,
};

export type ClipPriority = "now" | "ahead";

export interface ClipRequest {
  type: "clip";
  id: number;
  text: string;
  voice: string;
  rate: number;
  priority: ClipPriority;
  /** Only make sure the clip is stored; do not send the samples back. */
  storeOnly?: boolean;
}

export type ToWorker =
  | { type: "load"; choice: ModelChoice }
  | ClipRequest
  | { type: "cancel"; ids: number[] }
  /** Forget every request still waiting at this priority. */
  | { type: "drop"; priority: ClipPriority }
  | { type: "stored"; id: number; keys: string[] };

export interface ClipResult {
  type: "clip";
  id: number;
  /** Mono 16-bit samples at SAMPLE_RATE, or absent when `storeOnly`. */
  pcm?: ArrayBuffer;
  durationMs: number;
  words: AlignedWord[];
  /** Came from the store rather than being synthesised now. */
  cached: boolean;
  /** Wall time the worker spent on it, store lookup included. */
  tookMs: number;
}

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  /** The model has begun on this request. A heartbeat: the page uses it to
   *  tell a slow render from a worker that has died. */
  | { type: "working"; id: number; text: string }
  | { type: "ready"; choice: ModelChoice }
  | { type: "failed"; message: string; choice: ModelChoice }
  | ClipResult
  | { type: "clip-failed"; id: number; message: string }
  | { type: "stored"; id: number; keys: string[] };

/** The key a clip is stored under. Text is hashed rather than kept whole:
 *  a book's worth of sentences would otherwise be duplicated in the index. */
export function clipKey(voice: string, rate: number, text: string): string {
  const trimmed = text.trim();
  // FNV-1a over UTF-16 code units, twice with different seeds, so a
  // collision needs two sentences to agree on 64 bits as well as a length.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x27d4eb2f) >>> 0;
  }
  return `${voice}|${rate}|${trimmed.length}|${a.toString(36)}${b.toString(36)}`;
}
