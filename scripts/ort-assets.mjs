/**
 * Copies the onnxruntime WebAssembly files the offline voice runs on into
 * public/, under the transformers.js version they shipped with.
 *
 * transformers.js fetches these from a CDN unless told otherwise, and a CDN
 * is exactly what is not there when the reader has no connection. Served
 * from our own origin, the service worker keeps them like any other
 * versioned asset. `public/ort/` is not committed; `npm run dev`, `build`
 * and `start` all run this first, as they do for pdf.js.
 */
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

// The package hides package.json behind its exports map, so read it by path.
const root = path.join(process.cwd(), "node_modules", "@huggingface", "transformers");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const from = path.join(root, "dist");
const to = path.join(process.cwd(), "public", "ort", pkg.version);

await rm(path.join(process.cwd(), "public", "ort"), { recursive: true, force: true });
await mkdir(to, { recursive: true });

// The "jsep" build is the one transformers.js asks for: it carries the
// WebGPU backend as well as the plain WebAssembly one.
for (const file of ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]) {
  await cp(path.join(from, file), path.join(to, file));
}

console.log(`onnxruntime ${pkg.version} assets in public/ort/${pkg.version}`);
