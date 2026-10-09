import type { EngineVoice } from "../engine";

export const PIPER_PREFIX = "piper:";

export interface PiperVoice {
  id: string;
  name: string;
  lang: string;
  /** The model file, which is the whole download for this voice. */
  bytes: number;
  /** Piper's "high" voices: a larger model, clearly better, and about an
   *  eighth of the speed. Offered as premium, never chosen unasked. */
  premium: boolean;
}

/**
 * The medium voices first, because the first of them is what a chapter is
 * prepared in when the reader has not chosen, and the medium model is the
 * one that keeps up with speech on a phone. The high voices follow: the
 * best sound a phone can make on its own, at the cost of a longer wait to
 * prepare a chapter (measured in Safari on a Mac: three quarters of real
 * time where the medium model manages six times).
 */
export const PIPER_VOICES: readonly PiperVoice[] = [
  { id: "en_US-amy-medium", name: "Amy", lang: "en-US", bytes: 63_104_526, premium: false },
  { id: "en_US-ryan-medium", name: "Ryan", lang: "en-US", bytes: 63_201_294, premium: false },
  { id: "en_US-lessac-medium", name: "Lessac", lang: "en-US", bytes: 63_201_294, premium: false },
  { id: "en_GB-alan-medium", name: "Alan", lang: "en-GB", bytes: 63_201_294, premium: false },
  { id: "en_GB-cori-medium", name: "Cori", lang: "en-GB", bytes: 63_201_294, premium: false },
  { id: "en_US-lessac-high", name: "Lessac Premium", lang: "en-US", bytes: 113_900_000, premium: true },
  { id: "en_US-ryan-high", name: "Ryan Premium", lang: "en-US", bytes: 120_800_000, premium: true },
  { id: "en_GB-cori-high", name: "Cori Premium", lang: "en-GB", bytes: 114_200_000, premium: true },
];

/** Approximate size of a medium voice's model file. */
export const PIPER_MODEL_BYTES = 63_000_000;

export function piperVoiceBytes(voiceId: string): number {
  return PIPER_VOICES.find((voice) => voice.id === voiceId)?.bytes ?? PIPER_MODEL_BYTES;
}

export function piperEngineVoices(): EngineVoice[] {
  let medium = 0;
  let premium = 0;
  return PIPER_VOICES.map((voice) => ({
    id: `${PIPER_PREFIX}${voice.id}`,
    name: voice.name,
    lang: voice.lang,
    local: true,
    offline: true,
    isDefault: false,
    tier: "enhanced",
    // Premium voices rank above the medium ones in the picker, and below
    // Kokoro's; the medium ones step down from 0.89. Rounded so the
    // subtraction does not leave 0.8800000000000001.
    quality: voice.premium ? Math.round((0.93 - premium++ * 0.01) * 100) / 100 : Math.round((0.89 - medium++ * 0.01) * 100) / 100,
  }));
}

/** Piper's voices are published as <lang>/<lang>_<REGION>/<name>/<quality>/. */
export function piperModelUrls(voiceId: string): { onnx: string; json: string } {
  const [locale, name, quality] = voiceId.split("-");
  const [lang, region] = locale.split("_");
  const base = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${lang}/${lang}_${region}/${name}/${quality}/${voiceId}.onnx`;
  return { onnx: base, json: `${base}.json` };
}

export function isPiperVoice(voiceId: string | null | undefined): boolean {
  return !!voiceId && voiceId.startsWith(PIPER_PREFIX);
}
