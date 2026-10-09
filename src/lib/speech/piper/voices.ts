import type { EngineVoice } from "../engine";

export const PIPER_PREFIX = "piper:";

export const PIPER_VOICES: readonly { id: string; name: string; lang: string }[] = [
  { id: "en_US-amy-medium", name: "Amy", lang: "en-US" },
  { id: "en_US-ryan-medium", name: "Ryan", lang: "en-US" },
  { id: "en_US-lessac-medium", name: "Lessac", lang: "en-US" },
  { id: "en_GB-alan-medium", name: "Alan", lang: "en-GB" },
  { id: "en_GB-cori-medium", name: "Cori", lang: "en-GB" },
];

/** Approximate size of one voice's model file, for the reader's benefit. */
export const PIPER_MODEL_BYTES = 63_000_000;

export function piperEngineVoices(): EngineVoice[] {
  return PIPER_VOICES.map((voice, i) => ({
    id: `${PIPER_PREFIX}${voice.id}`,
    name: voice.name,
    lang: voice.lang,
    local: true,
    offline: true,
    isDefault: false,
    tier: "enhanced",
    // Rounded so the subtraction does not leave 0.8800000000000001.
    quality: Math.round((0.89 - i * 0.01) * 100) / 100,
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
