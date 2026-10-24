import { edgeEndpoints, edgeHeaders, voicesUrl } from "./protocol";

export interface EdgeVoiceTag {
  ContentCategories?: string[];
  VoicePersonalities?: string[];
}

/** The shape the rest of the app reads: the retired host's. The new host is
 *  normalised into it by `normalizeEdgeVoice`, so a consumer never needs to
 *  know which host answered. */
export interface EdgeVoice {
  Name: string;
  ShortName: string;
  Gender: "Female" | "Male";
  Locale: string;
  FriendlyName: string;
  Status: string;
  VoiceTag?: EdgeVoiceTag;
}

/**
 * What either host actually returns. The old host tagged a voice's uses as
 * `ContentCategories` ("News", "Novel") and named it in full
 * (`FriendlyName`, "Microsoft Aria Online (Natural) - English (United
 * States)"). The new host at api.msedgeservices.com tags uses as
 * `TailoredScenarios` ("Narration", "Audiobook", "Chat") and gives only a
 * `DisplayName` ("Aria") beside the `LocaleName`. The categories are what the
 * picker's "Recommended" and the engine's ranking read, so when the host
 * moved the label vanished from every voice until this mapping existed.
 */
export interface RawEdgeVoice {
  Name: string;
  ShortName: string;
  Gender: "Female" | "Male";
  Locale: string;
  LocaleName?: string;
  FriendlyName?: string;
  DisplayName?: string;
  Status: string;
  VoiceTag?: EdgeVoiceTag & { TailoredScenarios?: string[] };
}

export function normalizeEdgeVoice(raw: RawEdgeVoice): EdgeVoice {
  const tag = raw.VoiceTag;
  const categories = tag?.ContentCategories ?? tag?.TailoredScenarios;
  const friendly =
    raw.FriendlyName ??
    (raw.DisplayName ? `${raw.DisplayName}${raw.LocaleName ? ` - ${raw.LocaleName}` : ""}` : raw.ShortName);
  return {
    Name: raw.Name,
    ShortName: raw.ShortName,
    Gender: raw.Gender,
    Locale: raw.Locale,
    FriendlyName: friendly,
    Status: raw.Status,
    VoiceTag:
      categories || tag?.VoicePersonalities
        ? { ContentCategories: categories ?? [], VoicePersonalities: tag?.VoicePersonalities ?? [] }
        : undefined,
  };
}

/** The full list changes rarely; refetching it on every reader session would
 *  just be extra load on an endpoint we don't control. */
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache: { voices: EdgeVoice[]; fetchedAt: number } | null = null;

async function fetchVoiceList(): Promise<EdgeVoice[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.voices;

  // Tried in the same order synthesis uses, so a host that has stopped
  // answering costs one failed request an hour rather than the voice list.
  let lastStatus: string = "unreachable";
  for (const endpoint of edgeEndpoints()) {
    let response: Response;
    try {
      response = await fetch(voicesUrl(endpoint), { headers: edgeHeaders() });
    } catch (error) {
      lastStatus = error instanceof Error ? error.message : String(error);
      continue;
    }
    if (!response.ok) {
      lastStatus = `HTTP ${response.status}`;
      continue;
    }
    // A host that has stopped serving answers 200 with an empty body rather
    // than an error, as api.msedgeservices.com did in October 2026. Parsing
    // that threw out of the loop and lost the list though the next host had it.
    let raw: unknown;
    try {
      raw = JSON.parse(await response.text());
    } catch {
      lastStatus = `HTTP ${response.status} with no voice list`;
      continue;
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      lastStatus = `HTTP ${response.status} with no voices`;
      continue;
    }
    const voices = (raw as RawEdgeVoice[]).map(normalizeEdgeVoice);
    cache = { voices, fetchedAt: Date.now() };
    return voices;
  }
  throw new Error(`Edge voice list request failed (${lastStatus})`);
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
