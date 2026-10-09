import assert from "node:assert/strict";
import { test } from "node:test";
import { isPiperVoice, PIPER_PREFIX, piperEngineVoices, piperModelUrls } from "@/lib/speech/piper/voices";

test("model urls follow the hub's layout", () => {
  const { onnx, json } = piperModelUrls("en_US-amy-medium");
  assert.equal(onnx, "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx");
  assert.equal(json, `${onnx}.json`);
  assert.ok(piperModelUrls("en_GB-cori-medium").onnx.includes("/en/en_GB/cori/medium/"));
});

test("voices are prefixed, ordered and ranked", () => {
  const voices = piperEngineVoices();
  assert.deepEqual(voices.slice(0, 5).map((v) => v.name), ["Amy", "Ryan", "Lessac", "Alan", "Cori"]);
  assert.ok(voices.every((v) => v.id.startsWith(PIPER_PREFIX) && v.offline && v.local));
  assert.equal(voices[0].quality, 0.89);
  assert.equal(voices[4].quality, 0.85);
  // Medium voices step down; the premium voices after them rank above
  // every medium one, so the picker lists them first, and still step down.
  const medium = voices.slice(0, 5);
  const premium = voices.slice(5);
  for (let i = 1; i < medium.length; i++) assert.ok(medium[i].quality < medium[i - 1].quality);
  for (let i = 1; i < premium.length; i++) assert.ok(premium[i].quality < premium[i - 1].quality);
  assert.ok(premium.length >= 3);
  assert.ok(premium.every((voice) => voice.quality > medium[0].quality));
  assert.ok(premium.every((voice) => /Premium$/.test(voice.name)));
});

test("piper voices are recognised by prefix", () => {
  assert.ok(isPiperVoice("piper:en_US-amy-medium"));
  assert.ok(!isPiperVoice("af_heart"));
  assert.ok(!isPiperVoice(null));
});
