import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { segmentChapter, tokenizeWords, wordAtCharIndex } from "@/lib/text/segment";
import type { Chapter } from "@/lib/types";

function chapterOf(...paragraphs: string[]): Chapter {
  return {
    id: "c",
    title: "Test",
    blocks: paragraphs.map((text) => ({ kind: "p" as const, text })),
  };
}

test("splits a paragraph into sentences and keeps the text reconstructable", () => {
  const chapter = chapterOf(
    "Mrs. Dalloway said she would buy the flowers herself. For Lucy had her work cut out for her.",
  );
  const segmented = segmentChapter(chapter);

  assert.equal(segmented.sentences.length, 2);
  assert.match(segmented.sentences[0].speakable, /^Mrs\. Dalloway/);
  assert.match(segmented.sentences[1].speakable, /^For Lucy/);

  // Concatenating the sentences must reproduce the block exactly, or the
  // rendered text would silently differ from the source.
  const rebuilt = segmented.sentences.map((s) => s.text).join("");
  assert.equal(rebuilt, chapter.blocks[0].text);
});

test("does not break on an abbreviation or a decimal", () => {
  const segmented = segmentChapter(
    chapterOf("The Dr. arrived at 9.30 a.m. and left again. Nobody saw him."),
  );
  assert.equal(segmented.sentences.length, 2);
});

test("word offsets address the speakable text", () => {
  const segmented = segmentChapter(chapterOf("The doors would be taken off their hinges."));
  const sentence = segmented.sentences[0];
  const words = sentence.words.map((w) => sentence.speakable.slice(w.start, w.end));
  assert.deepEqual(words, ["The", "doors", "would", "be", "taken", "off", "their", "hinges"]);
});

test("lead offset lets rendered text and word offsets line up", () => {
  const segmented = segmentChapter(chapterOf("One. Two."));
  for (const sentence of segmented.sentences) {
    const first = sentence.words[0];
    assert.equal(
      sentence.text.slice(sentence.lead + first.start, sentence.lead + first.end),
      sentence.speakable.slice(first.start, first.end),
    );
  }
});

test("contractions and hyphenates stay one spoken word", () => {
  const words = tokenizeWords("don't half-open");
  assert.equal(words.length, 2);
});

test("a char index inside a word maps to that word", () => {
  const text = "The doors would be taken";
  const words = tokenizeWords(text);
  assert.equal(wordAtCharIndex(words, 0), 0);
  assert.equal(wordAtCharIndex(words, 5), 1); // inside "doors"
  assert.equal(wordAtCharIndex(words, 4), 1); // start of "doors"
  assert.equal(wordAtCharIndex(words, 3), 0); // the space after "The"
  assert.equal(wordAtCharIndex(words, 999), words.length - 1);
});

test("a block with no letters produces no speakable words", () => {
  const segmented = segmentChapter(chapterOf("* * *"));
  assert.equal(segmented.sentences.every((s) => s.words.length === 0), true);
});

test("a block's speakable override replaces a single-sentence block's spoken text", () => {
  const chapter: Chapter = {
    id: "c",
    title: "Test",
    blocks: [{ kind: "h1", text: "XXIII: Difficulties Ahead", speakable: "twenty-three: Difficulties Ahead" }],
  };
  const segmented = segmentChapter(chapter);
  const sentence = segmented.sentences[0];
  assert.equal(segmented.sentences.length, 1);
  assert.equal(sentence.text, "XXIII: Difficulties Ahead");
  assert.equal(sentence.speakable, "twenty-three: Difficulties Ahead");
  // A roman numeral is one token whichever way it's written, so the two
  // tokenize to the same count and word i in one is word i in the other -
  // that's what lets the synchronizer light "XXIII" from a boundary reported
  // against "twenty-three".
  assert.equal(sentence.words.length, sentence.speakableWords.length);
  assert.equal(sentence.words.length, 3);
  assert.equal(sentence.text.slice(sentence.words[0].start, sentence.words[0].end), "XXIII");
  assert.equal(
    sentence.speakable.slice(sentence.speakableWords[0].start, sentence.speakableWords[0].end),
    "twenty-three",
  );
});

test("a speakable override that changes the token count drops the highlight rather than misalign it", () => {
  const chapter: Chapter = {
    id: "c",
    title: "Test",
    blocks: [{ kind: "h1", text: "MCMLXXXIV", speakable: "one thousand nine hundred eighty-four" }],
  };
  const segmented = segmentChapter(chapter);
  const sentence = segmented.sentences[0];
  // One token on the page, five in speech: there is no honest index to map
  // through, so both are emptied rather than light the wrong word.
  assert.equal(sentence.words.length, 0);
  assert.equal(sentence.speakableWords.length, 0);
});

test("a speakable override is ignored on a block that splits into more than one sentence", () => {
  const chapter: Chapter = {
    id: "c",
    title: "Test",
    blocks: [{ kind: "p", text: "First. Second.", speakable: "override" }],
  };
  const segmented = segmentChapter(chapter);
  assert.equal(segmented.sentences.length, 2);
  assert.equal(segmented.sentences[0].speakable, "First.");
  assert.equal(segmented.sentences[1].speakable, "Second.");
});
