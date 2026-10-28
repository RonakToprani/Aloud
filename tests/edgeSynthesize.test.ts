import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { joinPieces, splitPassage } from "@/lib/speech/edge/synthesize";

const pieceTexts = (text: string, maxPieces?: number) =>
  splitPassage(text, maxPieces).map(({ start, end }) => text.slice(start, end));

test("a short passage goes out a sentence per piece", () => {
  const text = "The river was quiet that morning, and nobody spoke. " +
    "Far off a bell rang twice over the water. Then the boat came in.";
  assert.deepEqual(pieceTexts(text, 6), [
    "The river was quiet that morning, and nobody spoke.",
    "Far off a bell rang twice over the water.",
    "Then the boat came in.",
  ]);
});

test("a long passage is cut into about as many pieces as run at once", () => {
  const sentence = "The lantern by the window burned low through the long night. ";
  const text = (sentence.repeat(30) + "\n\n" + sentence.repeat(30)).trim();
  const pieces = splitPassage(text, 6);
  assert.ok(pieces.length >= 5 && pieces.length <= 7, `${pieces.length} pieces`);
});

test("the pieces cover the passage with nothing lost but the space between them", () => {
  const text = "One. Two!\n\nThree? “Four.” Five… Six.";
  const pieces = splitPassage(text, 10);
  assert.equal(pieces[0].start, 0);
  assert.equal(pieces[pieces.length - 1].end, text.length);
  for (let i = 1; i < pieces.length; i++) {
    assert.match(text.slice(pieces[i - 1].end, pieces[i].start), /^\s+$/);
  }
  assert.deepEqual(pieceTexts(text, 10), ["One.", "Two!", "Three?", "“Four.”", "Five…", "Six."]);
});

test("a title or an initial is not taken for the end of a sentence", () => {
  const text = "Mr. Darcy bowed. J. R. R. Tolkien wrote it. St. Paul was cold.";
  assert.deepEqual(pieceTexts(text, 10), [
    "Mr. Darcy bowed.",
    "J. R. R. Tolkien wrote it.",
    "St. Paul was cold.",
  ]);
});

test("a sentence longer than any piece is kept whole when it has nowhere to cut", () => {
  const text = "and on ".repeat(80) + "end.";
  assert.deepEqual(splitPassage(text, 6), [{ start: 0, end: text.length }]);
});

test("joined pieces shift words by the audio and the text before them", () => {
  // 48 kbit/s is six bytes a millisecond, so 600 bytes is 100ms.
  const joined = joinPieces([
    {
      range: { start: 0, end: 4 },
      synthesis: { audio: Buffer.alloc(600, 1), words: [{ charIndex: 0, charLength: 3, offsetMs: 10, durationMs: 50 }] },
    },
    {
      range: { start: 5, end: 9 },
      synthesis: { audio: Buffer.alloc(1200, 2), words: [{ charIndex: 0, charLength: 3, offsetMs: 10, durationMs: 50 }] },
    },
    {
      range: { start: 10, end: 14 },
      synthesis: { audio: Buffer.alloc(6, 3), words: [{ charIndex: 1, charLength: 2, offsetMs: 0, durationMs: 5 }] },
    },
  ]);
  assert.equal(joined.audio.length, 1806);
  assert.equal(joined.audio[599], 1);
  assert.equal(joined.audio[600], 2);
  assert.deepEqual(
    joined.words.map((w) => [w.charIndex, w.offsetMs, w.durationMs]),
    [
      [0, 10, 50],
      [5, 110, 50],
      [11, 300, 5],
    ],
  );
});

test("paragraphs are cut even when they end without a full stop", () => {
  const text = "Once upon a midnight dreary, while I pondered\n\nOver many a quaint and curious volume\n\nWhile I nodded, nearly napping";
  assert.deepEqual(pieceTexts(text, 6), [
    "Once upon a midnight dreary, while I pondered",
    "Over many a quaint and curious volume",
    "While I nodded, nearly napping",
  ]);
});

test("a run with no sentence end is cut at commas once it is far too long", () => {
  const text = Array.from({ length: 40 }, (_, i) => `line ${i} of the stanza`).join(", ");
  const pieces = splitPassage(text, 6);
  assert.ok(pieces.length >= 5, `${pieces.length} pieces`);
  for (const piece of pieces.slice(0, -1)) assert.ok(text.slice(piece.start, piece.end).endsWith(","));
});
