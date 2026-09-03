import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { Player, type PlayerState } from "@/lib/player/player";
import { segmentChapter, type SegmentedChapter } from "@/lib/text/segment";
import { FakeEngine } from "./fakeEngine";

const CHAPTERS = [
  ["Alpha one two.", "Bravo three four.", "* * *", "Charlie five six."],
  ["Delta seven eight."],
];

function build(msPerWord = 100) {
  const engine = new FakeEngine();
  engine.msPerWord = msPerWord;
  const segmented: SegmentedChapter[] = CHAPTERS.map((paragraphs, index) =>
    segmentChapter({
      id: `c${index}`,
      title: `Chapter ${index + 1}`,
      blocks: paragraphs.map((text) => ({ kind: "p" as const, text })),
    }),
  );

  const states: PlayerState[] = [];
  const player = new Player({
    engine,
    getChapter: (i) => segmented[i],
    chapterCount: segmented.length,
    rate: 1,
    voiceId: null,
    onState: (state) => states.push({ ...state }),
  });
  return { engine, player, states, segmented };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lastState(states: PlayerState[]): PlayerState {
  return states[states.length - 1];
}

test("plays one sentence per utterance and chains to the end of the book", async () => {
  const { engine, player, states } = build();
  player.play();
  await settle(2200);
  player.destroy();

  assert.equal(lastState(states).status, "ended");
  // Four speakable sentences: the "* * *" block has nothing to say.
  assert.deepEqual(
    engine.spoken.map((request) => request.text),
    ["Alpha one two.", "Bravo three four.", "Charlie five six.", "Delta seven eight."],
  );
});

test("crosses into the next chapter on its own", async () => {
  const { player, states } = build();
  player.play();
  await settle(2200);
  player.destroy();
  assert.ok(
    states.some((state) => state.chapterIndex === 1),
    "playback should reach the second chapter",
  );
});

test("tapping a word starts speaking from that word", async () => {
  const { engine, player } = build();
  player.playFrom(0, 1, 2); // "Bravo three four." -> from "four"
  await settle(160);
  player.destroy();
  assert.equal(engine.spoken[0].text, "four.");
});

test("an utterance that ends instantly is retried rather than skipped", async () => {
  const { engine, player } = build();
  engine.behaviour = "phantom";
  player.play();
  await settle(900);
  player.destroy();

  const firstSentence = engine.spoken.filter((r) => r.text === "Alpha one two.");
  assert.ok(
    firstSentence.length > 1,
    `a phantom end should be retried, saw ${firstSentence.length} attempt(s)`,
  );
});

test("repeated synthesis failure surfaces a message instead of looping forever", async () => {
  const { engine, player, states } = build();
  engine.behaviour = "phantom";
  player.play();
  await settle(2000);
  player.destroy();

  const failed = states.find((state) => state.error?.kind === "synthesis-failed");
  assert.ok(failed, "the reader should be told the voice stopped responding");
  assert.equal(failed?.status, "paused");
});

test("pause falls back to stopping when the engine ignores it", async () => {
  // A slow pace keeps the utterance genuinely in flight while we pause.
  const { engine, player, states } = build(400);
  engine.ignorePause = true;
  player.play();
  await settle(120);
  assert.equal(lastState(states).status, "playing");

  player.pause();
  assert.equal(lastState(states).status, "paused");

  // The verify window notices the engine kept talking and stops it hard.
  await settle(420);
  const spokenBeforeResume = engine.spoken.length;

  player.resume();
  await settle(80);
  player.destroy();

  assert.ok(
    engine.spoken.length > spokenBeforeResume,
    "resuming after a failed pause should speak again rather than sit silent",
  );
});

test("skipping backwards restarts the current sentence before stepping back", async () => {
  const { player, states } = build();
  player.seek(0, 1, 0);
  player.previousSentence();
  assert.equal(lastState(states).sentenceIndex, 0);
});

test("skipping forward steps over blocks with nothing to say", async () => {
  const { player, states } = build();
  player.seek(0, 1, 0);
  player.nextSentence();
  // Sentence 2 is "* * *", so the next spoken sentence is 3.
  assert.equal(lastState(states).sentenceIndex, 3);
});
