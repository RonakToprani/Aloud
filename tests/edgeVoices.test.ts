import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeEdgeVoice } from "@/lib/speech/edge/voices";

const base = { Name: "x", ShortName: "en-US-EricNeural", Gender: "Male" as const, Locale: "en-US", Status: "GA" };

test("the retired host's shape passes through unchanged", () => {
  const voice = normalizeEdgeVoice({
    ...base,
    FriendlyName: "Microsoft Eric Online (Natural) - English (United States)",
    VoiceTag: { ContentCategories: ["News", "Novel"], VoicePersonalities: ["Rational"] },
  });
  assert.equal(voice.FriendlyName, "Microsoft Eric Online (Natural) - English (United States)");
  assert.deepEqual(voice.VoiceTag, { ContentCategories: ["News", "Novel"], VoicePersonalities: ["Rational"] });
});

test("the new host's scenarios become the categories the picker reads", () => {
  const voice = normalizeEdgeVoice({
    ...base,
    DisplayName: "Eric",
    LocaleName: "English (United States)",
    VoiceTag: { TailoredScenarios: ["Assistant", "Narration"], VoicePersonalities: ["Confident", "Warm"] },
  });
  assert.equal(voice.FriendlyName, "Eric - English (United States)");
  assert.deepEqual(voice.VoiceTag?.ContentCategories, ["Assistant", "Narration"]);
  assert.deepEqual(voice.VoiceTag?.VoicePersonalities, ["Confident", "Warm"]);
});

test("a voice with no tag at all still has a name and no tag", () => {
  const voice = normalizeEdgeVoice({ ...base, ShortName: "en-GB-ThomasNeural" });
  assert.equal(voice.FriendlyName, "en-GB-ThomasNeural");
  assert.equal(voice.VoiceTag, undefined);
});
