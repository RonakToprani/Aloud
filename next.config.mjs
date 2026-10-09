import { readFileSync } from "node:fs";

/** The offline voice's runtime files live under this version in public/ort
 *  (scripts/ort-assets.mjs), and the client has to know the path. The
 *  package hides its package.json behind an exports map, so it is read by
 *  path. */
const transformersVersion = JSON.parse(
  readFileSync(new URL("./node_modules/@huggingface/transformers/package.json", import.meta.url), "utf8"),
).version;

/** Piper runs on the top-level onnxruntime-web (the plain build, which WebKit
 *  can run) and its own phonemiser; both are copied under their versions. */
const ortVersion = JSON.parse(
  readFileSync(new URL("./node_modules/onnxruntime-web/package.json", import.meta.url), "utf8"),
).version;
const piperWasmVersion = JSON.parse(
  readFileSync(new URL("./node_modules/@diffusionstudio/piper-wasm/package.json", import.meta.url), "utf8"),
).version;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_TRANSFORMERS_VERSION: transformersVersion,
    NEXT_PUBLIC_ORT_VERSION: ortVersion,
    NEXT_PUBLIC_PIPER_WASM_VERSION: piperWasmVersion,
  },
  // transformers.js is written for Node as well as the browser and imports
  // the Node halves unconditionally; webpack must be told they do not exist
  // here or it bundles sharp and onnxruntime-node for the browser and fails.
  webpack: (config) => {
    config.resolve.alias = {
      ...config.resolve.alias,
      sharp$: false,
      "onnxruntime-node$": false,
    };
    return config;
  },
  // `ws` picks between a native buffer-masking addon and a pure-JS fallback
  // at require time; bundling it breaks that check ("bufferUtil.mask is not
  // a function"). Left external, it's just required by Node as normal.
  serverExternalPackages: ["ws", "@huggingface/transformers", "kokoro-js"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default nextConfig;
