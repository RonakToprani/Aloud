/**
 * Copies the pdf.js worker and its data files into public/, under the
 * version they came from.
 *
 * The worker could be bundled instead, but every bundler spells that
 * differently and gets it wrong quietly: the import resolves, the worker
 * 404s, and pdf.js falls back to parsing on the main thread, where a long
 * book freezes the page. A plain file at a plain URL cannot do that.
 *
 * The version in the path is what lets the service worker treat these as
 * immutable, the same way it treats a built asset.
 */
import { createRequire } from "node:module";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const require = createRequire(import.meta.url);
const pkg = require("pdfjs-dist/package.json");
const from = path.dirname(require.resolve("pdfjs-dist/package.json"));
const to = path.join(process.cwd(), "public", "pdfjs", pkg.version);

await rm(path.join(process.cwd(), "public", "pdfjs"), { recursive: true, force: true });
await mkdir(to, { recursive: true });

await cp(path.join(from, "legacy/build/pdf.worker.min.mjs"), path.join(to, "pdf.worker.min.mjs"));
await cp(path.join(from, "standard_fonts"), path.join(to, "standard_fonts"), { recursive: true });
await cp(path.join(from, "cmaps"), path.join(to, "cmaps"), { recursive: true });

console.log(`pdf.js ${pkg.version} assets in public/pdfjs/${pkg.version}`);
