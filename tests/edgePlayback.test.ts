import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { EdgeSpeechEngine } from "@/lib/speech/edge/engine";
import { Player, type PlayerState } from "@/lib/player/player";
import { segmentChapter, type SegmentedChapter } from "@/lib/text/segment";
import { installHarness, type Harness } from "./edgeHarness";

/**
 * Pausing, resuming and changing voice against the real cloud engine.
 *
 * These are timing bugs between a pause, a passage still being fetched and
 * audio already scheduled on the audio clock, so they cannot be reached with a
 * fake engine: the fake has no clock and no passages. `edgeHarness.ts` stands
 * in for the browser instead, and knows the difference between a source having
 * been created and a sound actually coming out — which is the whole of the
 * first bug below.
 */

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PARAGRAPHS = [
  "Alpha one two three. Bravo four five six. Charlie seven eight nine.",
  "Delta ten eleven twelve. Echo thirteen fourteen fifteen.",
  "Foxtrot sixteen seventeen. Golf eighteen nineteen twenty.",
  "Hotel twenty one. India twenty two. Juliet twenty three.",
  "Kilo twenty four. Lima twenty five. Mike twenty six.",
  "November twenty seven. Oscar twenty eight. Papa twenty nine.",
];

interface Rig {
  harness: Harness;
  engine: EdgeSpeechEngine;
  player: Player;
  states: PlayerState[];
  /** When each sentence started, in wall-clock ms. */
  advances: number[];
  done(): void;
}

/** Short sentences, so a pause can be aimed at a sentence boundary many times
 *  over without the test taking a minute to do it. */
const BRIEF = [
  "Alpha one. Bravo two. Charlie three.",
  "Delta four. Echo five. Foxtrot six.",
  "Golf seven. Hotel eight. India nine.",
  "Juliet ten. Kilo eleven. Lima twelve.",
  "Mike thirteen. November fourteen. Oscar fifteen.",
  "Papa sixteen. Quebec seventeen. Romeo eighteen.",
  "Sierra nineteen. Tango twenty. Uniform twenty one.",
];

function build(voiceId = "edge:Aria", latencyMs = 25, paragraphs = PARAGRAPHS): Rig {
  const harness = installHarness();
  harness.latencyMs = latencyMs;
  const engine = new EdgeSpeechEngine();
  const chapter: SegmentedChapter = segmentChapter({
    id: "c0",
    title: "Chapter 1",
    blocks: paragraphs.map((text) => ({ kind: "p" as const, text })),
  });
  const states: PlayerState[] = [];
  const advances: number[] = [];
  const player = new Player({
    engine,
    getChapter: (index) => (index === 0 ? chapter : undefined),
    chapterCount: 1,
    rate: 1,
    voiceId,
    onState: (state) => states.push({ ...state }),
    onSentence: () => advances.push(Date.now()),
  });
  engine.unlock();
  return {
    harness,
    engine,
    player,
    states,
    advances,
    done: () => {
      player.destroy();
      engine.destroy();
      harness.restore();
    },
  };
}

const last = (states: PlayerState[]) => states[states.length - 1];

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > until) throw new Error("timed out waiting for the reading to move on");
    await settle(10);
  }
}

/**
 * A pause anywhere in a passage's life must hold, and the press of play after
 * it must produce a sound.
 *
 * Stated as one property over many pause points rather than as the one that
 * broke: the pause points that matter are the ones nobody would think to pick
 * — the last tick of a sentence's span, the dead air a passage owes the next
 * one, the seam where the following passage is already on the clock. Walking
 * the reading in small steps lands on all of them.
 */
test("a pause holds and a press of play sounds, wherever in the passage it lands", async () => {
  const rig = build("edge:Aria", 25, BRIEF);
  const { harness, player, states, advances } = rig;
  const failures: string[] = [];

  const check = async (where: string) => {
    const scheduled = harness.audible().length;
    player.pause();
    // Long enough for the 40ms passage watcher, the 300ms pause check and any
    // fetch that was in flight to have had their turn.
    await settle(420);
    if (last(states).status !== "paused") failures.push(`${where}: read to again after pausing`);
    if (harness.audible().length > scheduled) failures.push(`${where}: audio scheduled while paused`);
    if (harness.sounding()) failures.push(`${where}: still making a sound while paused`);
    player.play();
    // The gap a passage owes the next one is genuine dead air, so the question
    // is whether the reading comes back, not whether it is back this instant.
    const heard = await waitFor(() => harness.sounding(), 2500).then(
      () => true,
      () => false,
    );
    if (!heard) failures.push(`${where}: silence after a press of play`);
  };

  player.play();
  // Learn how long a sentence lasts, so a pause can be aimed at the instant
  // one ends. That is the pause nobody would think to try and the one that
  // broke: the watcher's next tick read the frozen playhead as the sentence
  // having finished, and the player advanced and started reading again.
  await waitFor(() => advances.length >= 3, 6000);
  const span = advances[2] - advances[1];
  assert.ok(span > 200, `sentences should take a moment each, measured ${span}ms`);

  // A sentence's end is not observable to the millisecond — the watcher only
  // looks every 40ms — so instead of racing it, creep the playhead across a
  // boundary in steps shorter than one tick. One step is then certain to leave
  // a paused playhead past the end of a sentence with the watcher yet to look
  // at it, and that is the pause that used to start the reading again by
  // itself about forty milliseconds after the reader asked for quiet.
  const seen = advances.length;
  await waitFor(() => advances.length > seen, 8000);
  await settle(Math.max(0, span - 140));
  for (let step = 0; step < 22; step++) {
    player.pause();
    await settle(70);
    if (last(states).status !== "paused") {
      failures.push(`step ${step} across a sentence ending: read to again after pausing`);
      break;
    }
    player.play();
    await settle(15);
  }
  await check("creeping across a sentence ending");

  // And at arbitrary points, which is where the dead air a passage owes the
  // next one and the seam the next passage is already scheduled on turn up.
  for (const at of [180, 900]) {
    await settle(at);
    if (last(states).status !== "playing") player.play();
    await settle(120);
    await check(`${at}ms in`);
    if (last(states).status === "ended") break;
  }

  rig.done();
  assert.deepEqual(failures, []);
});

/**
 * The engine's own answer to "is a voice speaking?" is the player's only way
 * of telling a reader in silence from a reader being read to, and the player's
 * recovery hangs off it. A passage promoted ahead of its scheduled start has a
 * live buffer source that will not make a sound for another half a minute;
 * while that counted as speaking, `play()` believed it was already playing and
 * returned without doing anything, and no number of presses of play and pause
 * got the reading back.
 */
test("the engine never claims to be speaking while nothing is coming out", async () => {
  const rig = build();
  const { harness, engine, player } = rig;
  player.play();

  for (let tick = 0; tick < 150; tick++) {
    await settle(40);
    if (tick % 17 === 8) player.pause();
    if (tick % 17 === 13) player.play();
    // The longest silence a reading legitimately contains is the gap after a
    // chapter heading, 700ms, and the next passage is already on the clock
    // through it. Audio a second or more away is not a seam; it is a reading
    // that has stopped, and saying otherwise is what left the reader with a
    // play button that did nothing.
    if (engine.isSpeaking() && !harness.soundingWithin(1000)) {
      rig.done();
      assert.fail("the engine reported speaking with no audio within a second");
    }
  }
  rig.done();
});

test("a press of play recovers the reading even when the player thinks it is playing", async () => {
  // The state the reader was left in: the player's status says playing, so the
  // button offers pause, and nothing is coming out. Play has to answer that.
  const rig = build();
  const { harness, engine, player, states } = rig;
  player.play();
  await settle(700);
  assert.equal(last(states).status, "playing");

  // Take the sound away behind the player's back, as a passage scheduled for
  // later or a context the system suspended does.
  engine.cancel();
  await settle(60);
  assert.equal(last(states).status, "playing", "the player still believes it is playing");
  assert.equal(harness.sounding(), false);

  const before = harness.audible().length;
  player.play();
  await settle(900);
  rig.done();
  assert.ok(harness.audible().length > before, "play must speak again rather than do nothing");
});

/**
 * Changing voice or speed mid-book.
 *
 * Voices are told apart by the amplitude of the audio the harness hands back,
 * so every buffer that reaches the audio clock can be attributed to the voice
 * that made it. The switch is aimed at a sentence boundary, which is where the
 * passage already fetched under the old voice covers everything about to be
 * read and so answers for it: the reader heard the new voice say the part of a
 * sentence it was asked for and the old one pick the book up again.
 */
async function switchAt(
  mid: boolean,
  change: (player: Player) => void,
): Promise<{ scheduled: string[]; heard: string[] }> {
  const rig = build("edge:Aria", 25, BRIEF);
  const { harness, player, advances } = rig;
  player.play();
  // Far enough in that a second passage has been fetched and scheduled behind
  // the first, which is the state the reader reported it from.
  await waitFor(() => advances.length >= 5, 15000);
  const span = advances[4] - advances[3];
  const seen = advances.length;
  await waitFor(() => advances.length > seen, 8000);
  if (mid) await settle(Math.round(span / 2));

  const mark = harness.audible().length;
  change(player);
  // Long enough for the old voice's next sentence to have come round.
  await settle(2500);
  const scheduled = [...new Set(harness.audible().slice(mark).map((entry) => entry.voice))];
  const heard = harness.soundingVoices();
  rig.done();
  return { scheduled, heard };
}

test("no audio from the old voice is scheduled once the voice changes", async () => {
  for (const mid of [false, true]) {
    const { scheduled, heard } = await switchAt(mid, (player) => player.setVoice("edge:Guy"));
    const where = mid ? "mid-sentence" : "at a sentence boundary";
    assert.ok(!scheduled.includes("Aria"), `switching ${where} scheduled the old voice again`);
    assert.ok(!heard.includes("Aria"), `switching ${where} left the old voice still reading`);
    assert.deepEqual(scheduled, ["Guy"], `switching ${where} scheduled ${scheduled.join(",") || "nothing"}`);
  }
});

test("no audio at the old speed is scheduled once the speed changes", async () => {
  // A passage is matched to a sentence by its text, which says nothing about
  // the speed it was synthesised at either. Both voices here are the same one,
  // so the evidence is in what was asked of the endpoint.
  const rig = build("edge:Aria", 25, BRIEF);
  const { harness, player, advances } = rig;
  player.play();
  await waitFor(() => advances.length >= 5, 15000);
  const seen = advances.length;
  await waitFor(() => advances.length > seen, 8000);
  const before = harness.calls.length;
  player.setRate(1.6);
  await settle(2500);
  const asked = harness.calls.slice(before).map((call) => call.rate);
  rig.done();
  assert.ok(asked.length > 0, "the new speed has to be synthesised");
  assert.deepEqual([...new Set(asked)], [1.6], `asked for ${asked.join(",")}`);
});

test("changing voice while paused does not bring the old one back on play", async () => {
  const rig = build("edge:Aria", 25, BRIEF);
  const { harness, player, advances } = rig;
  player.play();
  await waitFor(() => advances.length >= 3, 12000);
  player.pause();
  await settle(400);
  const mark = harness.audible().length;
  player.setVoice("edge:Guy");
  player.play();
  await settle(2500);
  const after = [...new Set(harness.audible().slice(mark).map((entry) => entry.voice))];
  rig.done();
  assert.ok(after.length > 0, "play must read in the voice just chosen");
  assert.deepEqual(after, ["Guy"], `heard ${after.join(",")}`);
});

test("a pause during the very first fetch still resumes", async () => {
  // Nothing has been decoded and no passage exists yet, so the utterance is
  // the stand-in that waits for one. Pausing it used to note an offset
  // measured from the context's own birth, and resuming then started the clip
  // past its own end — silently.
  const rig = build("edge:Aria", 700);
  const { harness, player, states } = rig;
  player.play();
  await settle(150);
  player.pause();
  assert.equal(last(states).status, "paused");
  await settle(900);
  assert.equal(harness.sounding(), false, "the fetch arriving must not start playing on its own");
  player.play();
  const heard = await waitFor(() => harness.sounding(), 2500).then(
    () => true,
    () => false,
  );
  rig.done();
  assert.ok(heard, "the reading must start after the pause");
});
