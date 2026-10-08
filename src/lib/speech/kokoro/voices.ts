import type { EngineVoice } from "../engine";

export const KOKORO_PREFIX = "kokoro:";

/**
 * The voices worth offering, of the fifty-odd the model ships. Kokoro's own
 * grades (A to F) separate them widely; the ones below are those graded B-
 * or better, plus two male voices, since the top of the list is otherwise
 * entirely female. The order is the order they are offered in.
 */
interface KokoroVoice {
  id: string;
  name: string;
  lang: string;
  grade: string;
}

export const KOKORO_VOICES: readonly KokoroVoice[] = [
  { id: "af_heart", name: "Heart", lang: "en-US", grade: "A" },
  { id: "af_bella", name: "Bella", lang: "en-US", grade: "A-" },
  { id: "af_nicole", name: "Nicole", lang: "en-US", grade: "B-" },
  { id: "am_michael", name: "Michael", lang: "en-US", grade: "C+" },
  { id: "am_fenrir", name: "Fenrir", lang: "en-US", grade: "C+" },
  { id: "bf_emma", name: "Emma", lang: "en-GB", grade: "B-" },
  { id: "bm_george", name: "George", lang: "en-GB", grade: "C" },
  { id: "bm_fable", name: "Fable", lang: "en-GB", grade: "C" },
];

/** Grade to the picker's 0..1 quality. The best sit just under the newest
 *  cloud voices (0.97), which still sound better, and above every device
 *  voice short of Apple's Premium ones. */
const GRADE_QUALITY: Record<string, number> = {
  A: 0.95,
  "A-": 0.94,
  "B-": 0.9,
  "C+": 0.88,
  C: 0.87,
};

export function kokoroEngineVoices(): EngineVoice[] {
  return KOKORO_VOICES.map((voice) => ({
    id: `${KOKORO_PREFIX}${voice.id}`,
    name: voice.name,
    lang: voice.lang,
    local: true,
    offline: true,
    isDefault: false,
    tier: "enhanced",
    quality: GRADE_QUALITY[voice.grade] ?? 0.85,
  }));
}

export function isKokoroVoice(voiceId: string | null | undefined): boolean {
  return !!voiceId?.startsWith(KOKORO_PREFIX);
}
