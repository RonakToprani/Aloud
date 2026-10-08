import type { EngineVoice } from "../engine";
import {
  PassageSpeechEngine,
  type PassageRequest,
  type SynthesisSource,
  type SynthesisedAudio,
  type TimedWord,
} from "../passageEngine";
import { getEdgeVoices, type EdgeVoice } from "./voicesClient";

export { locateSentences, pauseAfter } from "../passageEngine";

/** How long we wait for the voice list before giving up and running with
 *  on-device voices only. */
const READY_TIMEOUT_MS = 5000;

/** How much text each successive passage asks for. The first is small so
 *  pressing play feels immediate; the second is synthesised while the first
 *  plays and so can be larger; from then on there is a passage of margin. */
const PASSAGE_BUDGETS = [220, 700, 1500];

/**
 * ShortNames are structured — "en-US-AriaNeural", "en-US-AvaMultilingualNeural"
 * — so they make a far cleaner label than the FriendlyName, which repeats
 * "Microsoft … Online (Natural)" on every row and wraps to two lines in the
 * picker. The vendor and the technology are not what anyone is choosing
 * between; the voice is.
 */
function displayName(voice: EdgeVoice): string {
  const bare = (voice.ShortName.split("-").pop() ?? "").replace(/Neural$/, "");
  if (!bare) {
    return voice.FriendlyName.replace(/\s*-\s*[^-]+\([^)]+\)\s*$/, "").trim() || voice.FriendlyName;
  }
  // "AvaMultilingual" -> "Ava Multilingual"
  return bare.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

/** Voices Microsoft tags for long-form narration. In a reading app these are
 *  the ones actually worth reaching for, so they also rank above the
 *  conversational voices rather than merely being labelled. */
const NARRATION_TRAITS = new Set(["novel", "audiobook", "narration"]);

function isNarrationVoice(traits: string[]): boolean {
  return traits.some((trait) => NARRATION_TRAITS.has(trait.toLowerCase()));
}

/** "AvaMultilingualNeural", "AndrewMultilingualNeural" and so on: Microsoft's
 *  newest voice generation, retrained for more natural prosody across
 *  languages. Microsoft still tags them by conversational use ("Conversation",
 *  "Copilot") rather than "Novel" or "Narration", so a rule that only looked
 *  at ContentCategories would rank an older, flatter-sounding "Novel" voice
 *  above them — which is exactly backwards for how they actually sound read
 *  aloud over a chapter. Rank the generation first, the provider's own
 *  narration tag second. */
function isMultilingualVoice(shortName: string): boolean {
  return /multilingual/i.test(shortName);
}

function toEngineVoice(voice: EdgeVoice): EngineVoice {
  const name = displayName(voice);
  const traits = voice.VoiceTag?.ContentCategories ?? [];
  const quality = isMultilingualVoice(voice.ShortName) ? 0.97 : isNarrationVoice(traits) ? 0.92 : 0.85;
  return {
    traits,
    id: `edge:${voice.ShortName}`,
    name,
    lang: voice.Locale,
    local: false,
    isDefault: false,
    tier: "enhanced",
    quality,
  };
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export interface EdgeSpeechEngineOptions {
  /** Filter like 'en-' passed to getEdgeVoices; keeps the list to one
   *  language rather than every locale Microsoft ships. */
  localePrefix?: string;
}

/**
 * Microsoft Edge's cloud "Read Aloud" voices. Synthesis happens on our own
 * server (see `/api/speech/edge/synthesize`) and comes back as one MP3 plus
 * word timings; the MP3 is decoded here, once, ahead of time, so the engine
 * has a buffer that can start on the next audio tick. Edge leaves about a
 * second of silence after every sentence, hence `tighten`.
 */
class EdgeSource implements SynthesisSource {
  readonly id = "edge-tts";
  readonly prefix = "edge:";
  readonly budgets = PASSAGE_BUDGETS;
  readonly tighten = true;
  readonly failureMessage = "The cloud voice service didn't respond.";

  constructor(private readonly options: EdgeSpeechEngineOptions) {}

  supported(): boolean {
    return typeof fetch !== "undefined";
  }

  async loadVoices(): Promise<EngineVoice[]> {
    const timeout = new Promise<EdgeVoice[]>((resolve) => setTimeout(() => resolve([]), READY_TIMEOUT_MS));
    const voices = await Promise.race([getEdgeVoices(this.options.localePrefix), timeout]);
    return voices.map(toEngineVoice);
  }

  async synthesize(request: PassageRequest, ctx: BaseAudioContext, signal: AbortSignal): Promise<SynthesisedAudio> {
    const response = await fetch("/api/speech/edge/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({ text: request.text, voice: request.voice, rate: request.rate }),
    });
    if (!response.ok) throw new Error("The cloud voice service refused the request.");
    const payload = (await response.json()) as { audio: string; words: TimedWord[] };
    const buffer = await ctx.decodeAudioData(base64ToBytes(payload.audio));
    return { buffer, words: payload.words };
  }
}

/** The cloud voices, as a `SpeechEngine`. */
export class EdgeSpeechEngine extends PassageSpeechEngine {
  constructor(options: EdgeSpeechEngineOptions = {}) {
    super(new EdgeSource(options));
  }
}
