/**
 * Piper, a VITS model with one 63 MB file per voice, as an offline voice:
 * the light one, and the one that runs everywhere. On WebKit it is the
 * only offline voice (see `kokoro/adapter.ts` for why), and it runs there
 * at several times the speed of speech on the plain WebAssembly build of
 * onnxruntime; the WebGPU-capable builds hang WebKit, so this adapter never
 * asks for one.
 */

import type { EngineVoice } from "../engine";
import type { ModelChoice } from "../offline/protocol";
import type { OfflineModelAdapter } from "../offline/source";
import { PIPER_PREFIX, PIPER_VOICES, piperEngineVoices, piperModelUrls, piperVoiceBytes } from "./voices";

/** The runtime and the phonemiser are copied into public/ under the
 *  versions they came with (scripts/ort-assets.mjs). */
const ORT_PATHS = `/ort/${process.env.NEXT_PUBLIC_ORT_VERSION ?? "unknown"}/`;
const PIPER_PATHS = `/piper/${process.env.NEXT_PUBLIC_PIPER_WASM_VERSION ?? "unknown"}/`;

/** The cache the worker keeps voice files in. */
export const PIPER_CACHE = "aloud-models";

export class PiperAdapter implements OfflineModelAdapter {
  readonly id = "piper";
  readonly prefix = PIPER_PREFIX;
  readonly failureMessage = "The offline voice couldn't read that. Press play to try again.";
  readonly perVoice = true;

  voices(): EngineVoice[] {
    return piperEngineVoices();
  }

  supported(): boolean {
    return true;
  }

  async chooseBackend(voice: string | null): Promise<ModelChoice> {
    return { backend: "wasm", dtype: "fp32", wasmPaths: ORT_PATHS, piperPaths: PIPER_PATHS, voice: voice ?? PIPER_VOICES[0].id };
  }

  async isDownloaded(choice: ModelChoice): Promise<boolean> {
    try {
      if (typeof caches === "undefined" || !choice.voice) return false;
      const cache = await caches.open(PIPER_CACHE);
      return !!(await cache.match(piperModelUrls(choice.voice).onnx));
    } catch {
      return false;
    }
  }

  downloadBytes(choice: ModelChoice): number {
    return piperVoiceBytes(choice.voice ?? PIPER_VOICES[0].id);
  }

  createWorker(): Worker {
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }
}
