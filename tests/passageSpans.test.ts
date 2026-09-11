import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { locateSentences } from "@/lib/speech/edge/engine";
import { planPassage } from "@/lib/speech/edge/passage";

function plan(...sentences: string[]) {
  const built = planPassage(
    sentences.map((text, i) => ({ text, endsParagraph: i === sentences.length - 1 })),
    1500,
  );
  assert.ok(built, "the passage planned");
  return built;
}

/** One timed word per sentence, at a given offset, addressed to the passage. */
function wordAt(text: string, word: string, offsetMs: number) {
  const charIndex = text.indexOf(word);
  assert.ok(charIndex >= 0, `${word} is in the passage`);
  return { charIndex, charLength: word.length, offsetMs, durationMs: 200 };
}

test("a sentence's span runs from its first word to the next sentence's", () => {
  const built = plan("Alpha one.", "Bravo two.", "Charlie three.");
  const { startMs, endMs } = locateSentences(
    built,
    [
      wordAt(built.text, "Alpha", 0),
      wordAt(built.text, "Bravo", 900),
      wordAt(built.text, "Charlie", 1800),
    ],
    2700,
    380,
  );
  assert.deepEqual(startMs, [0, 900, 1800]);
  assert.deepEqual(endMs, [900, 1800, 3080]);
});

test("a sentence the voice gave no timing for never ends before it begins", () => {
  const built = plan("Alpha one.", "Bravo two.", "Charlie three.");
  // The middle sentence got no word of its own, which is what a voice that
  // normalises a word away does.
  const { startMs, endMs } = locateSentences(
    built,
    [wordAt(built.text, "Alpha", 0), wordAt(built.text, "Charlie", 1800)],
    2700,
    380,
  );

  // Every span moves forward, and none of them is empty. A zero here used to
  // put the first sentence's end before its own start, which the player reads
  // as the sentence ending the instant it began — and answers by rewinding
  // the passage, so the reader hears the paragraph start over.
  for (let i = 0; i < startMs.length; i++) {
    assert.ok(endMs[i] > startMs[i], `sentence ${i} has a span: ${startMs[i]}..${endMs[i]}`);
    if (i > 0) assert.ok(startMs[i] >= startMs[i - 1], `sentence ${i} does not start earlier`);
  }
  assert.equal(startMs[0], 0);
  assert.equal(startMs[2], 1800);
});

test("out-of-order word timings never walk a span backwards", () => {
  const built = plan("Alpha one.", "Bravo two.");
  const { startMs, endMs } = locateSentences(
    built,
    [wordAt(built.text, "Alpha", 1200), wordAt(built.text, "Bravo", 300)],
    2000,
    380,
  );
  assert.ok(startMs[1] >= startMs[0]);
  assert.ok(endMs[0] > startMs[0]);
});
