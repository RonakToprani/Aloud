import type { EdgeVoice } from "./voices";

export type { EdgeVoice, EdgeVoiceTag } from "./voices";

/**
 * Fetches the available Microsoft Edge TTS voices, from this app's own
 * `/api/speech/edge/voices` route rather than Microsoft's endpoint directly.
 *
 * The endpoint doesn't grant a browser page CORS access, and reaching it
 * needs a per-five-minute signed token (see `protocol.ts`); a server route
 * we control can do both without leaking that machinery to the client.
 *
 * @param localePrefix Optional filter like 'en-' or 'en-US'
 */
export async function getEdgeVoices(localePrefix?: string): Promise<EdgeVoice[]> {
  try {
    const params = localePrefix ? `?locale=${encodeURIComponent(localePrefix)}` : "";
    const response = await fetch(`/api/speech/edge/voices${params}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as EdgeVoice[];
  } catch (error) {
    console.error("Failed to fetch Edge TTS voices:", error);
    return [];
  }
}
