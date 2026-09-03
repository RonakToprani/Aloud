import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { classifyVoice } from "@/lib/speech/webSpeechEngine";
import { isUsefulVoice, pickDefaultVoice } from "@/lib/hooks/useSpeechEngine";
import type { EngineVoice } from "@/lib/speech/engine";

const voice = (voiceURI: string, name: string) => classifyVoice({ voiceURI, name });

test("Apple quality tiers are read from the voiceURI, not the name", () => {
  assert.equal(voice("com.apple.voice.premium.en-US.Ava", "Ava"), "premium");
  assert.equal(voice("com.apple.voice.enhanced.en-GB.Serena", "Serena"), "enhanced");
  assert.equal(voice("com.apple.voice.compact.en-US.Samantha", "Samantha"), "compact");
});

test("Eloquence voices are treated as novelty however they are named", () => {
  // These are the robotic ones iOS ships dozens of, and they collide with
  // ordinary human names — "Reed" exists as both Eloquence and a real voice.
  assert.equal(voice("com.apple.eloquence.en-US.Reed", "Reed"), "novelty");
  assert.equal(voice("com.apple.eloquence.en-GB.Sandy", "Sandy"), "novelty");
  assert.equal(voice("com.apple.voice.premium.en-US.Reed", "Reed"), "premium");
});

test("Siri voices are marked unusable rather than offered", () => {
  assert.equal(voice("com.apple.ttsbundle.siri_Nicky_en-US_compact", "Nicky"), "siri");
});

test("the old macOS joke voices are novelty", () => {
  assert.equal(voice("com.apple.speech.synthesis.voice.Zarvox", "Zarvox"), "novelty");
  assert.equal(voice("com.apple.speech.synthesis.voice.Bubbles", "Bubbles"), "novelty");
});

test("desktop browser voices land in usable tiers", () => {
  assert.equal(voice("Google UK English Female", "Google UK English Female"), "standard");
  assert.equal(
    voice("urn:moz-tts:sapi:Microsoft Aria Online (Natural)", "Microsoft Aria Online (Natural)"),
    "enhanced",
  );
});

function engineVoice(partial: Partial<EngineVoice>): EngineVoice {
  return {
    id: partial.id ?? "v",
    name: partial.name ?? "Voice",
    lang: partial.lang ?? "en-US",
    local: partial.local ?? true,
    isDefault: partial.isDefault ?? false,
    tier: partial.tier ?? "standard",
    quality: partial.quality ?? 0.6,
    ...partial,
  } as EngineVoice;
}

test("a book never opens in a joke voice", () => {
  const voices = [
    engineVoice({ id: "junk", tier: "novelty", quality: 0.02, isDefault: true }),
    engineVoice({ id: "good", tier: "premium", quality: 1 }),
  ];
  assert.equal(pickDefaultVoice(voices, "en-GB")?.id, "good");
});

test("a downloaded Premium voice outranks the compact one it replaces", () => {
  const voices = [
    engineVoice({ id: "compact", tier: "compact", quality: 0.38, isDefault: true }),
    engineVoice({ id: "premium", tier: "premium", quality: 1 }),
  ];
  assert.equal(pickDefaultVoice(voices, "en-US")?.id, "premium");
});

test("the picker hides other languages and junk until asked", () => {
  const filter = { preferredLang: "en-GB" };
  assert.equal(isUsefulVoice(engineVoice({ lang: "en-GB", tier: "premium" }), filter), true);
  assert.equal(isUsefulVoice(engineVoice({ lang: "en-US", tier: "compact" }), filter), true);
  assert.equal(isUsefulVoice(engineVoice({ lang: "fr-FR", tier: "premium" }), filter), false);
  assert.equal(isUsefulVoice(engineVoice({ lang: "en-GB", tier: "novelty" }), filter), false);
  assert.equal(isUsefulVoice(engineVoice({ lang: "en-GB", tier: "siri" }), filter), false);
  // ...but everything is reachable behind the toggle.
  assert.equal(
    isUsefulVoice(engineVoice({ lang: "fr-FR", tier: "novelty" }), { ...filter, showAll: true }),
    true,
  );
});

test("falls back to another language rather than offering nothing", () => {
  const voices = [engineVoice({ id: "fr", lang: "fr-FR", tier: "premium", quality: 1 })];
  assert.equal(pickDefaultVoice(voices, "en-GB")?.id, "fr");
});
