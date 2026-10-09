/**
 * Kokoro, an 82-million-parameter model, as an offline voice: the most
 * natural of the offline voices, and the heaviest. It runs on the GPU
 * through WebGPU where that offers 16-bit floats, several times faster
 * than speech, and on the CPU through WebAssembly elsewhere, about half as
 * fast as speech. It does not run on WebKit at all; see `isWebKit`.
 */

import type { EngineVoice } from "../engine";
import { MODEL_BYTES, MODEL_ID, type Backend, type Dtype, type ModelChoice } from "../offline/protocol";
import type { OfflineModelAdapter } from "../offline/source";
import { kokoroEngineVoices, KOKORO_PREFIX } from "./voices";

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

/**
 * Every browser on iPhone and iPad is WebKit, and so is Safari on a Mac,
 * and on WebKit this model does not run. Measured in Safari 18.3 on a Mac,
 * which is what the iPhone showed too: the model loads, the first sentence
 * begins, and it never returns — on the GPU path, on the CPU path, pinned
 * to one thread, with the plain runtime, with the unquantised model, in a
 * worker and on the page. The content process either climbs past 2 GB and
 * is killed, or sits idle at 1.5 GB for good. WebKit gets Piper instead.
 */
export function isWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  // Any browser on an iPhone or iPad, including an iPad calling itself a
  // Mac; and Safari itself anywhere.
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua);
}

const CPU_CHOICE: ModelChoice = { backend: "wasm", dtype: "q8", wasmPaths: WASM_PATHS };

export class KokoroAdapter implements OfflineModelAdapter {
  readonly id = "kokoro";
  readonly prefix = KOKORO_PREFIX;
  readonly failureMessage = "The offline voice couldn't read that. Press play to try again.";
  readonly perVoice = false;

  voices(): EngineVoice[] {
    return kokoroEngineVoices();
  }

  supported(): boolean {
    return typeof navigator !== "undefined" && !isWebKit();
  }

  /** The GPU path needs WebGPU with 16-bit floats; everything else runs the
   *  8-bit model on the CPU. */
  async chooseBackend(): Promise<ModelChoice> {
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
    return CPU_CHOICE;
  }

  /** transformers.js keeps the model's files in its own cache; looked up
   *  directly so the question can be answered without waking the worker. */
  async isDownloaded(choice: ModelChoice): Promise<boolean> {
    try {
      if (typeof caches === "undefined") return false;
      const cache = await caches.open("transformers-cache");
      return !!(await cache.match(modelFile(choice.dtype)));
    } catch {
      return false;
    }
  }

  downloadBytes(choice: ModelChoice): number {
    return MODEL_BYTES[choice.dtype];
  }

  createWorker(): Worker {
    return new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  }

  /** The GPU path is the one that fails on a device that claims to offer
   *  it. Remember, and read with the CPU model from here on. */
  fallback(choice: ModelChoice): ModelChoice | null {
    if (choice.backend !== "webgpu") return null;
    remember({ avoid: "webgpu" });
    return CPU_CHOICE;
  }

  noteStall(choice: ModelChoice): void {
    if (choice.backend === "webgpu") remember({ avoid: "webgpu" });
  }
}
