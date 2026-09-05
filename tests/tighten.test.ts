import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyCuts,
  DEFAULT_TIGHTEN,
  findSilentRuns,
  planCuts,
  remapMs,
  remapWords,
  type SentenceSpan,
  type TimedWordLike,
} from "../src/lib/speech/edge/tighten";

const SR = 24000;

/** Build a signal from a script of [ms, loud?] segments. */
function signal(parts: [number, boolean][]): Float32Array {
  const total = parts.reduce((n, [ms]) => n + Math.round((ms / 1000) * SR), 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const [ms, loud] of parts) {
    const n = Math.round((ms / 1000) * SR);
    if (loud) for (let i = 0; i < n; i++) out[at + i] = 0.3 * Math.sin(i / 7);
    at += n;
  }
  return out;
}

// Two sentences, Edge-shaped: 195ms lead, 1000ms between, 900ms tail.
const TEXT = "One two. Three four.";
const parts: [number, boolean][] = [
  [195, false],
  [1200, true], // "One two."
  [1000, false],
  [1400, true], // "Three four."
  [900, false],
];
const words: TimedWordLike[] = [
  { charIndex: 0, charLength: 3, offsetMs: 100, durationMs: 500 },
  { charIndex: 4, charLength: 4, offsetMs: 700, durationMs: 500 },
  { charIndex: 9, charLength: 5, offsetMs: 2300, durationMs: 600 }, // ~95ms early, like Edge
  { charIndex: 15, charLength: 5, offsetMs: 3000, durationMs: 700 },
];
const sentences: SentenceSpan[] = [
  { start: 0, end: 8, endsParagraph: false },
  { start: 9, end: TEXT.length, endsParagraph: false },
];

describe("finding silence", () => {
  it("reports every silent run in ms", () => {
    const runs = findSilentRuns(signal(parts), SR);
    assert.equal(runs.length, 3);
    assert.equal(runs[0].fromMs, 0);
    assert.ok(Math.abs(runs[0].toMs - 195) <= 5);
    assert.ok(Math.abs(runs[1].toMs - runs[1].fromMs - 1000) <= 10);
    assert.ok(Math.abs(runs[2].toMs - 4695) <= 5, `tail ends at ${runs[2].toMs}`);
  });
});

describe("planning cuts", () => {
  it("shortens the lead, the sentence gap and the tail", () => {
    const cuts = planCuts(signal(parts), SR, words, sentences);
    assert.equal(cuts.length, 3);
    const [lead, gap, tail] = cuts;
    assert.equal(lead.fromMs, 0);
    assert.ok(Math.abs(lead.toMs - (195 - DEFAULT_TIGHTEN.leadMs)) <= 5);
    assert.ok(Math.abs(gap.toMs - gap.fromMs - (1000 - DEFAULT_TIGHTEN.sentencePauseMs)) <= 10);
    // The cut comes out of the middle, leaving silence either side of the splice.
    assert.ok(gap.fromMs > 1395 && gap.toMs < 2395);
    assert.ok(Math.abs(tail.toMs - tail.fromMs - 900) <= 10, "tail removed entirely");
  });

  it("gives a paragraph end a longer pause", () => {
    const cuts = planCuts(signal(parts), SR, words, [
      { ...sentences[0], endsParagraph: true },
      sentences[1],
    ]);
    const gap = cuts[1];
    assert.ok(Math.abs(gap.toMs - gap.fromMs - (1000 - DEFAULT_TIGHTEN.paragraphPauseMs)) <= 10);
  });

  it("leaves short phrasing pauses alone", () => {
    const short: [number, boolean][] = [[40, false], [500, true], [250, false], [500, true], [0, false]];
    const w: TimedWordLike[] = [
      { charIndex: 0, charLength: 3, offsetMs: 40, durationMs: 500 },
      { charIndex: 4, charLength: 4, offsetMs: 790, durationMs: 500 },
    ];
    const cuts = planCuts(signal(short), SR, w, [{ start: 0, end: 8, endsParagraph: false }]);
    assert.equal(cuts.length, 0);
  });

  it("keeps the natural tail when asked", () => {
    const cuts = planCuts(signal(parts), SR, words, sentences, { ...DEFAULT_TIGHTEN, trailMs: null });
    assert.equal(cuts.length, 2);
  });
});

describe("applying cuts", () => {
  it("removes exactly the cut samples and shifts the timings", () => {
    const original = signal(parts);
    const cuts = planCuts(original, SR, words, sentences);
    const out = applyCuts(original, SR, cuts);
    const toSample = (ms: number) => Math.round((ms / 1000) * SR);
    const removed = cuts.reduce((n, c) => n + toSample(c.toMs) - toSample(c.fromMs), 0);
    assert.equal(out.length, original.length - removed);

    const shifted = remapWords(words, cuts);
    // The first word's timing sat inside the lead silence (Edge runs early),
    // so it lands on the splice rather than going negative.
    assert.equal(shifted[0].offsetMs, 0);
    // Third word moves up by the lead cut plus the gap cut.
    const gapRemoved = cuts[1].toMs - cuts[1].fromMs;
    assert.ok(Math.abs(shifted[2].offsetMs - (2300 - cuts[0].toMs - gapRemoved)) <= 1);
    // Durations survive.
    assert.equal(shifted[3].durationMs, 700);
    // The spoken audio still sits where the timings say: the splice and the
    // word onset are less than a frame apart after remapping.
    const runs = findSilentRuns(out, SR);
    const gap = runs[1];
    assert.ok(Math.abs(gap.toMs - gap.fromMs - DEFAULT_TIGHTEN.sentencePauseMs) <= 10);
  });

  it("maps a time inside a cut onto the splice", () => {
    const cuts = [{ fromMs: 100, toMs: 300 }];
    assert.equal(remapMs(50, cuts), 50);
    assert.equal(remapMs(200, cuts), 100);
    assert.equal(remapMs(400, cuts), 200);
  });
});
