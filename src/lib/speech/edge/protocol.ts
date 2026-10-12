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

/**
 * Where the service lives, in the order they are tried.
 *
 * On 10 October 2026 the host Edge had used for years began refusing every
 * synthesis handshake with an empty 403 while still answering its voice list,
 * because Edge 155 had moved to `api.msedgeservices.com` and the old host was
 * being retired region by region (rany2/edge-tts#490). The new host accepts
 * the same token, signed the same way, as long as it is also passed as
 * `Ocp-Apim-Subscription-Key`. Both are kept: a handshake refused on one is
 * retried on the next, so the next move costs a round trip rather than the
 * voice. `EDGE_TTS_ENDPOINT` puts a further base URL in front of these, so a
 * host change can be met from Vercel's environment without a deploy.
 */
export interface EdgeEndpoint {
  /** Base URL without a trailing slash; `/websocket/v1` and `/voices/list` are
   *  appended, so it must be the path below which both live. */
  base: string;
}

const KNOWN_ENDPOINTS: EdgeEndpoint[] = [
  { base: "https://api.msedgeservices.com/tts/cognitiveservices" },
  { base: "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud" },
];

export function edgeEndpoints(): EdgeEndpoint[] {
  const extra = process.env.EDGE_TTS_ENDPOINT?.trim().replace(/\/+$/, "");
  return extra ? [{ base: extra }, ...KNOWN_ENDPOINTS] : KNOWN_ENDPOINTS;
}

const WINDOWS_EPOCH_OFFSET = 11644473600n;
/** The token is only regenerated every five minutes. */
const WINDOW_SECONDS = 300n;

/** SHA-256 of the current Windows file time, rounded down to a five minute
 *  window, concatenated with the client token. */
export function secMsGec(now = Date.now()): string {
  let seconds = BigInt(Math.floor(now / 1000)) + WINDOWS_EPOCH_OFFSET;
  seconds -= seconds % WINDOW_SECONDS;
  const ticks = seconds * 10_000_000n;
  return createHash("sha256").update(`${ticks}${TRUSTED_CLIENT_TOKEN}`, "ascii").digest("hex").toUpperCase();
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
    "Sec-MS-GEC-Version": `1-${CHROMIUM_VERSION}`,
  });
}

export function synthesisUrl(endpoint: EdgeEndpoint): string {
  const params = signedParams();
  params.set("ConnectionId", randomUUID().replace(/-/g, ""));
  return `${endpoint.base.replace(/^http/, "ws")}/websocket/v1?${params}`;
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
