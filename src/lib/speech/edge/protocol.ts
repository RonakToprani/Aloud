import { createHash, randomUUID } from "node:crypto";

/**
 * Microsoft's Edge "Read Aloud" endpoint.
 *
 * This is the consumer endpoint the Edge browser itself uses, not a documented
 * API. It is free and needs no key, and it returns word-boundary timings, which
 * is why it is worth having. It can also change or stop working without notice,
 * so every caller must be able to fall back to on-device voices.
 */
export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

/** The endpoint rejects versions it considers stale — 130 is already refused.
 *  Override with EDGE_TTS_CHROMIUM_VERSION if this starts returning 403. */
export const CHROMIUM_VERSION = process.env.EDGE_TTS_CHROMIUM_VERSION ?? "140.0.3485.14";

/** The server reads only the `2-` prefix, which selects the v2 token below;
 *  a `1-` version with a v1 token is an empty 403. */
export const SEC_MS_GEC_VERSION = `2-${CHROMIUM_VERSION}`;

/**
 * Where the service lives, in the order they are tried.
 *
 * On 10 October 2026 `speech.platform.bing.com` began refusing synthesis with
 * an empty 403, and `api.msedgeservices.com` answered the same v1 token
 * (rany2/edge-tts#490), so the new host went first. By 23 October the new
 * host answered every request, handshake and voice list alike, with an empty
 * 200, and the old host was synthesising again for anyone sending the v2
 * token. The 403 had been the token all along, not a retirement.
 *
 * Each host keeps its socket at a different path, and a wrong one is not a
 * 404: the old host answers `/websocket/v1` with a 400 "services aren't
 * available" page, which looks like an outage. Both hosts are kept; a
 * refused handshake moves to the next, so the next change costs a round trip
 * rather than the voice. `EDGE_TTS_ENDPOINT` (with `EDGE_TTS_SOCKET_PATH`
 * when it is not `/websocket/v1`) puts a further host in front from Vercel's
 * environment, without a deploy.
 */
export interface EdgeEndpoint {
  /** Base URL without a trailing slash; `/voices/list` is appended to it. */
  base: string;
  /** Where the synthesis socket lives below `base`. */
  socketPath: string;
}

const KNOWN_ENDPOINTS: EdgeEndpoint[] = [
  { base: "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud", socketPath: "/edge/v1" },
  { base: "https://api.msedgeservices.com/tts/cognitiveservices", socketPath: "/websocket/v1" },
];

export function edgeEndpoints(): EdgeEndpoint[] {
  const extra = process.env.EDGE_TTS_ENDPOINT?.trim().replace(/\/+$/, "");
  if (!extra) return KNOWN_ENDPOINTS;
  const path = process.env.EDGE_TTS_SOCKET_PATH?.trim().replace(/\/+$/, "") || "/websocket/v1";
  return [{ base: extra, socketPath: path.startsWith("/") ? path : `/${path}` }, ...KNOWN_ENDPOINTS];
}

const WINDOWS_EPOCH_OFFSET = 11644473600n;
/** The token is only regenerated every five minutes. */
const WINDOW_SECONDS = 300n;

/** Part of what Edge itself hashes, not a notice: without it the token is
 *  refused. */
const TOKEN_PREFIX = "Copyright (C) Microsoft Corporation. All rights reserved.";

/** CS64 multipliers for the first (x) and second (y) word of each pair. */
const SWAP_X = [0xef0569fb, 0x76f50f34, 0xc3efea97] as const;
const SWAP_Y = [0xc31713db, 0x1881ce3c, 0x35bd1ec9] as const;
const STATE_X = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83] as const;
const STATE_Y = [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69] as const;

const rotate16 = (value: number) => (value << 16) | (value >>> 16);

/** Math.imul, not `*`: the products overflow a double's 53 bits and only the
 *  low 32 survive in the native code being matched. */
function swapMix(word: number, key: number, [pre, mid, post]: readonly number[]): number {
  const t = rotate16((Math.imul(rotate16(word), pre) + Math.imul(word, key)) | 0);
  const q = Math.imul(t, mid);
  return (Math.imul(rotate16(q), post) + q) | 0;
}

function stateMix(value: number, key: number, factors: readonly number[]): number {
  let state = Math.imul(value, key);
  for (const factor of factors) state = Math.imul(rotate16(state), factor);
  return state;
}

/** Two 32-bit chains over the input as little-endian word pairs, keyed by the
 *  first eight bytes of its SHA-256. */
function cs64(data: Buffer, digest: Buffer): Buffer {
  const keyA = digest.readUInt32LE(0) | 1;
  const keyB = digest.readUInt32LE(4) | 1;
  const padded = Buffer.alloc(Math.ceil(data.length / 8) * 8);
  data.copy(padded);

  let swapSum = 0;
  let swapLast = 0;
  let state = 0;
  let sum = 0;
  for (let offset = 0; offset < padded.length; offset += 8) {
    const x = padded.readUInt32LE(offset);
    const y = padded.readUInt32LE(offset + 4);
    const swapX = swapMix(x, keyA, SWAP_X);
    swapLast = swapMix(y, keyB, SWAP_Y);
    swapSum = (swapSum + swapX + swapLast) | 0;
    state = stateMix((state + x) | 0, keyA, STATE_X);
    sum = (sum + state) | 0;
    state = stateMix((state + y) | 0, keyB, STATE_Y);
    sum = (sum + state) | 0;
  }

  const out = Buffer.alloc(8);
  out.writeUInt32LE((swapLast ^ state) >>> 0, 0);
  out.writeUInt32LE((swapSum ^ sum) >>> 0, 4);
  return out;
}

/**
 * The v2 token: `<CS64>-<SHA-256>`, both over the prefix, the Windows file
 * time rounded down to a five minute window, and the client token. Protocol
 * from rany2/edge-tts#490 and #492.
 */
export function secMsGec(now = Date.now()): string {
  let seconds = BigInt(Math.floor(now / 1000)) + WINDOWS_EPOCH_OFFSET;
  seconds -= seconds % WINDOW_SECONDS;
  const ticks = seconds * 10_000_000n;
  const data = Buffer.from(`${TOKEN_PREFIX}${ticks}${TRUSTED_CLIENT_TOKEN}`, "ascii");
  const digest = createHash("sha256").update(data).digest();
  return `${cs64(data, digest).toString("hex")}-${digest.toString("hex")}`.toUpperCase();
}

export function edgeHeaders(): Record<string, string> {
  return {
    Origin: "chrome-extension://jdiccldimpahbcfnjlfmpnbmiedpnpaa",
    "User-Agent":
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `Chrome/${CHROMIUM_VERSION} Safari/537.36 Edg/${CHROMIUM_VERSION}`,
    Pragma: "no-cache",
    "Cache-Control": "no-cache",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

/** The old host reads `TrustedClientToken` and the new one
 *  `Ocp-Apim-Subscription-Key`; each ignores the other, so one query serves
 *  both. The signed token is required by both. */
function signedParams(): URLSearchParams {
  return new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    "Ocp-Apim-Subscription-Key": TRUSTED_CLIENT_TOKEN,
    "Sec-MS-GEC": secMsGec(),
    "Sec-MS-GEC-Version": SEC_MS_GEC_VERSION,
  });
}

export function synthesisUrl(endpoint: EdgeEndpoint): string {
  const params = signedParams();
  params.set("ConnectionId", randomUUID().replace(/-/g, ""));
  return `${endpoint.base.replace(/^http/, "ws")}${endpoint.socketPath}?${params}`;
}

export function voicesUrl(endpoint: EdgeEndpoint): string {
  return `${endpoint.base}/voices/list?${signedParams()}`;
}

export function escapeSsml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Our 0.5–2.5 multiplier as the percentage the endpoint expects. */
export function ratePercent(rate: number): string {
  const percent = Math.round((Math.min(2.5, Math.max(0.5, rate)) - 1) * 100);
  return `${percent >= 0 ? "+" : ""}${percent}%`;
}
