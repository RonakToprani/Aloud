import { edgeHeaders, voicesUrl } from "./protocol";

export interface EdgeVoiceTag {
  ContentCategories?: string[];
  VoicePersonalities?: string[];
}

export interface EdgeVoice {
  Name: string;
  ShortName: string;
  Gender: "Female" | "Male";
  Locale: string;
  FriendlyName: string;
  Status: string;
  VoiceTag?: EdgeVoiceTag;
}

/** The full list changes rarely; refetching it on every reader session would
 *  just be extra load on an endpoint we don't control. */
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache: { voices: EdgeVoice[]; fetchedAt: number } | null = null;

async function fetchVoiceList(): Promise<EdgeVoice[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.voices;

  const response = await fetch(voicesUrl(), { headers: edgeHeaders() });
  if (!response.ok) {
    throw new Error(`Edge voice list request failed (HTTP ${response.status})`);
  }
  const voices = (await response.json()) as EdgeVoice[];
  cache = { voices, fetchedAt: Date.now() };
  return voices;
}

/**
 * Fetches the available Microsoft Edge TTS voices, server-side.
 * @param localePrefix Optional filter like 'en-' or 'en-US'
 */
export async function getEdgeVoices(localePrefix?: string): Promise<EdgeVoice[]> {
  const voices = await fetchVoiceList();
  if (!localePrefix) return voices;
  return voices.filter((voice) => voice.Locale.toLowerCase().startsWith(localePrefix.toLowerCase()));
}
