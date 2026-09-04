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

const SYNTHESIS_HOST =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const VOICES_HOST =
  "https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list";

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

export function synthesisUrl(): string {
  const params = new URLSearchParams({
    TrustedClientToken: TRUSTED_CLIENT_TOKEN,
    "Sec-MS-GEC": secMsGec(),
    "Sec-MS-GEC-Version": `1-${CHROMIUM_VERSION}`,
    ConnectionId: randomUUID().replace(/-/g, ""),
  });
  return `${SYNTHESIS_HOST}?${params}`;
}

export function voicesUrl(): string {
  const params = new URLSearchParams({
    trustedclienttoken: TRUSTED_CLIENT_TOKEN,
    "Sec-MS-GEC": secMsGec(),
    "Sec-MS-GEC-Version": `1-${CHROMIUM_VERSION}`,
  });
  return `${VOICES_HOST}?${params}`;
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
