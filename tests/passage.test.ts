import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { planPassage, type PassageInput } from "@/lib/speech/edge/passage";

const s = (text: string, endsParagraph = false): PassageInput => ({ text, endsParagraph });

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
