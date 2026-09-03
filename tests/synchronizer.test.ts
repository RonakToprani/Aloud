import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { SentenceSynchronizer, type SyncMode } from "@/lib/speech/synchronizer";
import { segmentChapter } from "@/lib/text/segment";
import { FakeEngine, type Behaviour } from "./fakeEngine";

const TEXT = "The doors would be taken off their hinges and carried away before noon.";

function sentenceOf(text: string) {
  return segmentChapter({ id: "c", title: "t", blocks: [{ kind: "p", text }] }).sentences[0];
}

/** Run one sentence through the synchronizer against a given engine. */
function runSentence(
  behaviour: Behaviour,
  options: { rate?: number; msPerWord?: number } = {},
): Promise<{
  visited: number[];
  modes: SyncMode[];
  stalled: boolean;
  finalMode: SyncMode;
  wordCount: number;
  wordsSeenBeforeEnd: number;
}> {
  const engine = new FakeEngine();
  engine.behaviour = behaviour;
  engine.msPerWord = options.msPerWord ?? 40;

  const sentence = sentenceOf(TEXT);
  const visited: number[] = [];
  const modes: SyncMode[] = [];
  let stalled = false;

  return new Promise((resolve) => {
    const sync = new SentenceSynchronizer({
      sentenceText: sentence.speakable,
      words: sentence.words,
      startWordIndex: 0,
      rate: options.rate ?? 1,
      voiceId: `voice-${behaviour}`,
      onWord: (index) => {
        if (visited[visited.length - 1] !== index) visited.push(index);
      },
      onMode: (mode) => modes.push(mode),
      onStall: () => {
        stalled = true;
        sync.stop();
        resolve({
          visited,
          modes,
          stalled,
          finalMode: sync.strategy,
          wordCount: sentence.words.length,
          wordsSeenBeforeEnd: visited.length,
        });
      },
    });

    engine.speak(
      { text: sentence.speakable, voiceId: null, rate: options.rate ?? 1 },
      {
        onStart: () => sync.start(),
        onBoundary: (event) => sync.boundary(event.charIndex),
        onEnd: () => {
          const seenBeforeEnd = visited.length;
          sync.end();
          resolve({
            visited,
            modes,
            stalled,
            finalMode: sync.strategy,
            wordCount: sentence.words.length,
            wordsSeenBeforeEnd: seenBeforeEnd,
          });
        },
      },
    );
  });
}

test("boundary events drive the highlight word by word", async () => {
  const result = await runSentence("events");
  assert.equal(result.finalMode, "events");
  assert.deepEqual(
    result.visited,
    Array.from({ length: result.wordCount }, (_, i) => i),
    "every word should be visited exactly once, in order",
  );
});

test("an engine that sends no boundaries still moves the highlight", async () => {
  // Chosen so the estimated clock outlives the 400ms detection window.
  const result = await runSentence("silent", { msPerWord: 130 });
  assert.equal(result.finalMode, "estimated");
  assert.ok(
    result.wordsSeenBeforeEnd > 2,
    `the estimated timer should advance during the utterance, saw ${result.wordsSeenBeforeEnd}`,
  );
  assert.equal(result.visited[result.visited.length - 1], result.wordCount - 1);
});

test("the highlight never stalls when boundary events dry up mid-sentence", async () => {
  // An engine whose pace matches the rate it was handed — the ordinary case.
  const result = await runSentence("stops-midway", { rate: 1, msPerWord: 330 });
  assert.ok(result.modes.includes("events"), "should start out trusting the events");
  assert.equal(result.finalMode, "estimated", "and fall back once they stop");
  assert.ok(
    result.wordsSeenBeforeEnd >= result.wordCount * 0.6,
    `the highlight should track most of the sentence, saw ${result.wordsSeenBeforeEnd} of ${result.wordCount}`,
  );
});

test("a voice much faster than the model still advances, and calibration closes the gap", async () => {
  // 130ms per word at rate 1 is far quicker than the baseline model expects.
  // The first sentence tracks poorly on purpose; what matters is that it keeps
  // moving, and that learning from real durations makes the next ones better.
  const first = await runSentence("silent", { rate: 1, msPerWord: 130 });
  assert.ok(first.wordsSeenBeforeEnd >= 3, "the highlight must keep moving even when badly mismatched");

  let latest = first;
  for (let i = 0; i < 5; i++) latest = await runSentence("silent", { rate: 1, msPerWord: 130 });

  assert.ok(
    latest.wordsSeenBeforeEnd > first.wordsSeenBeforeEnd,
    `tracking should improve as calibration learns: ${first.wordsSeenBeforeEnd} -> ${latest.wordsSeenBeforeEnd}`,
  );
  assert.ok(
    latest.wordsSeenBeforeEnd >= latest.wordCount * 0.6,
    `and settle near the real pace, saw ${latest.wordsSeenBeforeEnd} of ${latest.wordCount}`,
  );
});

test("the highlight only ever moves forward within a sentence", async () => {
  const result = await runSentence("stops-midway", { rate: 1, msPerWord: 330 });
  for (let i = 1; i < result.visited.length; i++) {
    assert.ok(result.visited[i] > result.visited[i - 1], "words must not regress");
  }
});

test("synthesis that starts and dies is reported as a stall", async () => {
  const result = await runSentence("dead", { rate: 6 });
  assert.equal(result.stalled, true);
});

test("estimated timing calibrates itself towards the real duration", async () => {
  const { getCalibration, recordCalibration } = await import("@/lib/speech/estimator");
  const voice = "calibration-probe";
  const before = getCalibration(voice);
  // Sentences that consistently take 50% longer than the model predicts.
  // The estimate is rebuilt from the current calibration each round, exactly
  // as the synchronizer does, so the loop must settle rather than run away.
  const BASE_ESTIMATE = 2000;
  const REAL = 3000;
  for (let i = 0; i < 12; i++) {
    recordCalibration(voice, BASE_ESTIMATE * getCalibration(voice), REAL);
  }
  const after = getCalibration(voice);
  assert.ok(after > before, `calibration should rise: ${before} -> ${after}`);
  assert.ok(after > 1.2 && after < 1.6, `and converge near the real ratio, got ${after}`);
});
