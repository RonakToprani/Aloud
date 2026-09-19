import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { planPassage, type PassageInput } from "@/lib/speech/edge/passage";
import { pauseAfter } from "@/lib/speech/edge/engine";
import { DEFAULT_TIGHTEN } from "@/lib/speech/edge/tighten";

const s = (text: string, endsParagraph = false): PassageInput => ({ text, endsParagraph });
const heading = (text: string): PassageInput => ({ text, endsParagraph: true, isHeading: true });

test("groups sentences into one passage", () => {
  const plan = planPassage([s("One two."), s("Three four."), s("Five six.", true)], 200);
  assert.equal(plan?.sentences.length, 3);
  assert.equal(plan?.text, "One two. Three four. Five six.");
});

test("each sentence's range addresses the passage text", () => {
  const plan = planPassage([s("One two."), s("Three four.", true)], 200)!;
  for (const sentence of plan.sentences) {
    assert.equal(plan.text.slice(sentence.start, sentence.end), sentence.text);
  }
});

test("paragraphs are separated by a blank line", () => {
  const plan = planPassage([s("End of one.", true), s("Start of two.")], 200)!;
  assert.match(plan.text, /End of one\.\n\nStart of two\./);
  // The ranges must still line up once the separator is two characters wider.
  for (const sentence of plan.sentences) {
    assert.equal(plan.text.slice(sentence.start, sentence.end), sentence.text);
  }
});

test("a passage ends at a paragraph break rather than wherever the budget runs out", () => {
  const inputs = [
    s("Alpha one."),
    s("Alpha two.", true),
    s("Beta one."),
    s("Beta two."),
    s("Beta three.", true),
  ];
  // Room for roughly four sentences, so the budget would otherwise cut in the
  // middle of the second paragraph — the one place a pitch reset is audible.
  const plan = planPassage(inputs, 44)!;
  assert.equal(plan.sentences.at(-1)?.text, "Alpha two.");
  assert.ok(!plan.text.includes("Beta"), "should not start a paragraph it cannot finish");
});

test("a paragraph longer than the budget is still read", () => {
  const inputs = [s("A sentence that is comfortably longer than the budget allows.", true)];
  const plan = planPassage(inputs, 10)!;
  assert.equal(plan.sentences.length, 1, "the first sentence is always taken");
});

test("falls back to a sentence boundary when no paragraph ends in range", () => {
  const inputs = [s("One."), s("Two."), s("Three."), s("Four.", true)];
  const plan = planPassage(inputs, 11)!;
  assert.ok(plan.sentences.length >= 1 && plan.sentences.length < 4);
  assert.equal(plan.text.length <= 11 || plan.sentences.length === 1, true);
});

test("empty input yields no passage", () => {
  assert.equal(planPassage([], 200), null);
  assert.equal(planPassage([s("   ")], 200), null);
});

test("a heading ends its passage even with room to spare", () => {
  // Measured against the live endpoint: the gap Edge leaves after a heading
  // (no terminal punctuation) is shorter than the gap between two ordinary
  // sentences, so tighten.ts's trim-only cuts can never lengthen it back up.
  // Ending the passage here instead gives the heading a scheduled gap before
  // the next passage — genuine dead air rather than a trimmed one.
  const inputs = [heading("I: A Fellow Traveller"), s("The story begins here."), s("And continues.", true)];
  const plan = planPassage(inputs, 1500)!;
  assert.equal(plan.sentences.length, 1);
  assert.equal(plan.sentences[0].text, "I: A Fellow Traveller");
  assert.equal(plan.sentences[0].isHeading, true);
  assert.ok(!plan.text.includes("story"), "the paragraph waits for the next passage");
});

test("a heading gets the dedicated pause rather than the ordinary paragraph one", () => {
  const withHeading = planPassage([heading("Chapter One")], 1500)!;
  const withParagraph = planPassage([s("End of paragraph.", true)], 1500)!;
  const withSentence = planPassage([s("Mid-paragraph.", false)], 1500)!;
  assert.equal(pauseAfter(withHeading), DEFAULT_TIGHTEN.headingPauseMs);
  assert.equal(pauseAfter(withParagraph), DEFAULT_TIGHTEN.paragraphPauseMs);
  assert.equal(pauseAfter(withSentence), DEFAULT_TIGHTEN.sentencePauseMs);
  assert.ok(DEFAULT_TIGHTEN.headingPauseMs > DEFAULT_TIGHTEN.paragraphPauseMs);
});

// A heading ends its passage but does not begin one: the tail of the
// paragraph before it is synthesised in the same request, so the pause
// before the heading is Edge's paragraph break, trimmed like any other,
// while the pause after it is the scheduled seam. Making a heading open its
// own passage would leave a passage a second long between two fetches, and
// the engine only looks one passage ahead, so the story after it would
// more often than not be waited for rather than scheduled.
test("a heading after a paragraph is synthesised with it and still ends the passage", () => {
  const inputs = [s("End of the chapter.", true), heading("Part Two"), s("The story goes on."), s("And on.", true)];
  const plan = planPassage(inputs, 1500)!;
  assert.deepEqual(
    plan.sentences.map((sentence) => sentence.text),
    ["End of the chapter.", "Part Two"],
  );
  assert.equal(plan.text, "End of the chapter.\n\nPart Two");
  assert.equal(plan.sentences[1].isHeading, true);
  assert.equal(pauseAfter(plan), DEFAULT_TIGHTEN.headingPauseMs);
});
