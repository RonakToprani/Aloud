import assert from "node:assert/strict";
import { test } from "node:test";
import {
  alignClip,
  alignWords,
  findSilentRuns,
  pausesAfter,
  splitLongSentence,
  tokenize,
  voicedBounds,
} from "@/lib/speech/kokoro/align";
import { clipKey } from "@/lib/speech/kokoro/protocol";
import { assemble } from "@/lib/speech/kokoro/source";

const RATE = 24000;

/** A clip with speech where `voiced` says, silence elsewhere. */
function clip(totalMs: number, voiced: [number, number][]): Float32Array {
  const samples = new Float32Array(Math.round((totalMs / 1000) * RATE));
  for (const [from, to] of voiced) {
    const a = Math.round((from / 1000) * RATE);
    const b = Math.round((to / 1000) * RATE);
    for (let i = a; i < b; i++) samples[i] = i % 2 ? 0.3 : -0.3;
  }
  return samples;
}

test("silent runs are found with their edges", () => {
  const runs = findSilentRuns(clip(1000, [[200, 500]]), RATE);
  assert.equal(runs.length, 2);
  assert.ok(Math.abs(runs[0].fromMs - 0) < 6 && Math.abs(runs[0].toMs - 200) < 6);
  assert.ok(Math.abs(runs[1].fromMs - 500) < 6 && Math.abs(runs[1].toMs - 1000) < 6);
});

test("trimming keeps a little lead and trail and nothing more", () => {
  const { start, end } = voicedBounds(clip(2000, [[300, 1200]]), RATE);
  assert.ok(Math.abs(start / RATE - 0.26) < 0.01, `start ${start / RATE}`);
  assert.ok(Math.abs(end / RATE - 1.22) < 0.01, `end ${end / RATE}`);
});

test("an all-silent clip is left whole rather than emptied", () => {
  const samples = clip(500, []);
  assert.deepEqual(voicedBounds(samples, RATE), { start: 0, end: samples.length });
});

test("words are weighted by phonemes, not letters", () => {
  const tokens = tokenize("through idea");
  // "through" is three phonemes; "idea" is four.
  const words = alignWords(tokens, [3, 4], 0, 1000, []);
  assert.equal(words.length, 2);
  assert.equal(words[0].offsetMs, 0);
  assert.ok(words[0].durationMs < words[1].durationMs, `${words[0].durationMs} vs ${words[1].durationMs}`);
  assert.ok(Math.abs(words[0].durationMs + words[1].durationMs - 1000) <= 2);
});

test("a measured pause anchors the words around the comma", () => {
  const tokens = tokenize("Yes, it was late.");
  // Speech 0..300, pause 300..600, speech 600..1500.
  const words = alignWords(tokens, [3, 2, 3, 3], 0, 1500, [{ fromMs: 300, toMs: 600 }]);
  assert.equal(words[0].offsetMs, 0);
  assert.equal(words[0].offsetMs + words[0].durationMs, 300, "Yes ends where the pause starts");
  assert.equal(words[1].offsetMs, 600, "it starts where the pause ends");
  assert.equal(words[3].offsetMs + words[3].durationMs, 1500);
});

test("a pause far from any plausible boundary is left alone", () => {
  const tokens = tokenize("one two three four five six seven eight");
  const even = tokens.map(() => 3);
  // A pause at the very start, before any word could have ended.
  const words = alignWords(tokens, even, 0, 4000, [{ fromMs: 10, toMs: 400 }]);
  assert.equal(words.length, 8);
  // Still monotonic and still filling the span.
  for (let i = 1; i < words.length; i++) assert.ok(words[i].offsetMs >= words[i - 1].offsetMs);
  const last = words[words.length - 1];
  assert.ok(Math.abs(last.offsetMs + last.durationMs - 4000) <= 2);
});

test("alignClip trims and places words inside the kept audio", () => {
  const samples = clip(3000, [
    [250, 1000],
    [1300, 2500],
  ]);
  const { start, end, words } = alignClip("First part, second part.", samples, RATE, [4, 3, 5, 3]);
  const keptMs = ((end - start) / RATE) * 1000;
  assert.ok(keptMs > 2200 && keptMs < 2350, `kept ${keptMs}`);
  assert.equal(words.length, 4);
  // The comma pause lands between "part," and "second".
  const pauseStart = 1000 - 250 + 40;
  const pauseEnd = 1300 - 250 + 40;
  assert.ok(Math.abs(words[1].offsetMs + words[1].durationMs - pauseStart) <= 3, `${words[1].offsetMs + words[1].durationMs}`);
  assert.ok(Math.abs(words[2].offsetMs - pauseEnd) <= 3, `${words[2].offsetMs}`);
  for (const word of words) assert.ok(word.offsetMs >= 0 && word.offsetMs + word.durationMs <= keptMs + 1);
});

test("pause punctuation is recognised through closing quotes", () => {
  assert.ok(pausesAfter("said,"));
  assert.ok(pausesAfter("said,”"));
  assert.ok(pausesAfter("however;"));
  assert.ok(pausesAfter("so—"));
  assert.ok(!pausesAfter("said."));
  assert.ok(!pausesAfter("plain"));
});

test("a long sentence is split at clause breaks and offsets survive", () => {
  const clause = "the light fell slowly across the room, ";
  const text = clause.repeat(12).trim() + ".";
  const chunks = splitLongSentence(text, 120);
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.ok(chunk.text.length <= 120, `chunk of ${chunk.text.length}`);
    assert.equal(text.slice(chunk.charIndex, chunk.charIndex + chunk.text.length), chunk.text);
  }
  // Every clause break chosen follows a comma.
  for (const chunk of chunks.slice(0, -1)) assert.ok(/,$/.test(chunk.text), chunk.text.slice(-10));
  assert.deepEqual(splitLongSentence("Short.", 120), [{ text: "Short.", charIndex: 0 }]);
});

test("clip keys differ by voice, rate and text, and ignore outer whitespace", () => {
  assert.equal(clipKey("af_heart", 1, "Hello there."), clipKey("af_heart", 1, "  Hello there. "));
  assert.notEqual(clipKey("af_heart", 1, "Hello there."), clipKey("af_bella", 1, "Hello there."));
  assert.notEqual(clipKey("af_heart", 1, "Hello there."), clipKey("af_heart", 1.2, "Hello there."));
  assert.notEqual(clipKey("af_heart", 1, "Hello there."), clipKey("af_heart", 1, "Hello here."));
});

test("a passage is assembled with the agreed gaps and re-based words", () => {
  const created: { length: number; data: Float32Array }[] = [];
  const ctx = {
    createBuffer(_channels: number, length: number) {
      const data = new Float32Array(length);
      created.push({ length, data });
      return { length, getChannelData: () => data };
    },
  } as unknown as BaseAudioContext;
  const pcm = (ms: number) => {
    const arr = new Int16Array(Math.round((ms / 1000) * RATE)).fill(1000);
    return arr.buffer;
  };
  const sentences = [
    { text: "One two.", start: 0, end: 8, endsParagraph: true, isHeading: false },
    { text: "Three.", start: 10, end: 16, endsParagraph: false, isHeading: false },
  ];
  const clips = [
    {
      type: "clip" as const,
      id: 1,
      pcm: pcm(1000),
      durationMs: 1000,
      cached: true,
      words: [
        { charIndex: 0, charLength: 3, offsetMs: 40, durationMs: 400 },
        { charIndex: 4, charLength: 4, offsetMs: 440, durationMs: 500 },
      ],
    },
    {
      type: "clip" as const,
      id: 2,
      pcm: pcm(500),
      durationMs: 500,
      cached: true,
      words: [{ charIndex: 0, charLength: 6, offsetMs: 40, durationMs: 400 }],
    },
  ];
  const { buffer, words } = assemble(ctx, sentences, clips);
  // A paragraph ends after the first sentence: 620ms of silence between.
  assert.equal(buffer.length, Math.round((1000 + 620 + 500) / 1000 * RATE));
  assert.equal(words.length, 3);
  assert.deepEqual(words[1], { charIndex: 4, charLength: 4, offsetMs: 440, durationMs: 500 });
  assert.equal(words[2].charIndex, 10, "second sentence's word addresses the passage");
  assert.equal(words[2].offsetMs, 1000 + 620 + 40);
  const data = created[0].data;
  assert.ok(data[100] > 0, "first clip's samples are in");
  assert.equal(data[Math.round(1.2 * RATE)], 0, "the gap is silent");
  assert.ok(data[Math.round(1.7 * RATE)] > 0, "second clip's samples follow the gap");
});
