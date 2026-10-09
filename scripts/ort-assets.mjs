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

// Piper runs on the plain build of the top-level onnxruntime-web: the jsep
// build hangs WebKit, and Kokoro's does not finish a sentence there either.
const ortRoot = path.join(process.cwd(), "node_modules", "onnxruntime-web");
const ortPkg = JSON.parse(await readFile(path.join(ortRoot, "package.json"), "utf8"));
const ortTo = path.join(process.cwd(), "public", "ort", ortPkg.version);
await mkdir(ortTo, { recursive: true });
for (const file of ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"]) {
  await cp(path.join(ortRoot, "dist", file), path.join(ortTo, file));
}

// The phonemiser is a separate WebAssembly module with its own data file.
const piperRoot = path.join(process.cwd(), "node_modules", "@diffusionstudio", "piper-wasm");
const piperPkg = JSON.parse(await readFile(path.join(piperRoot, "package.json"), "utf8"));
const piperTo = path.join(process.cwd(), "public", "piper", piperPkg.version);
await rm(path.join(process.cwd(), "public", "piper"), { recursive: true, force: true });
await mkdir(piperTo, { recursive: true });
for (const file of ["piper_phonemize.js", "piper_phonemize.wasm", "piper_phonemize.data"]) {
  await cp(path.join(piperRoot, "build", file), path.join(piperTo, file));
}

console.log(`onnxruntime ${ortPkg.version} assets in public/ort/${ortPkg.version}`);
console.log(`piper ${piperPkg.version} assets in public/piper/${piperPkg.version}`);
console.log(`onnxruntime ${pkg.version} assets in public/ort/${pkg.version}`);
