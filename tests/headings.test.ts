import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { speakHeadingNumerals } from "@/lib/text/headings";
import { tokenizeWords } from "@/lib/text/segment";

// A heading is where "I" and "V" are numbers, but a heading also holds a
// title, and a title is prose: "Why I Left" has a pronoun in it, "MIX" is a
// word, and a rule that converted any run of I, V, X, L, C, D, M read them
// all as numbers. Only the positions a heading puts a number in count.
test("a numeral is read as a number where a heading puts numbers", () => {
  const spoken: [string, string][] = [
    ["IV", "four"],
    ["XIV.", "fourteen."],
    ["I —", "one —"],
    ["i", "one"],
    ["Book II, Chapter IV", "Book two, Chapter four"],
    ["PART I. THE ARRIVAL, CHAPTER V", "PART one. THE ARRIVAL, CHAPTER five"],
    ["Act III. Scene II.", "Act three. Scene two."],
    ["one: Part V", "one: Part five"],
    ["Book the IV", "Book the four"],
    ["Chapter: IV", "Chapter: four"],
    ["Vol. II", "Vol. two"],
    ["I. The Arrival", "one. The Arrival"],
    ["XII: Home", "twelve: Home"],
    ["II — The Sea", "two — The Sea"],
    ["Part Two — IV", "Part Two — four"],
    ["Part II, in which I fall", "Part two, in which I fall"],
  ];
  for (const [heading, expected] of spoken) {
    assert.equal(speakHeadingNumerals(heading), expected, heading);
  }
});

test("the same letters anywhere else in a heading stay words", () => {
  const words = [
    "Why I Left",
    "I Am Legend",
    "MIX AND MATCH",
    "CIVIL WAR",
    "The XL Files",
    "LIV AND LET DIE",
    "CD COLLECTION",
    "Louis XIV",
    "Mix",
    "Chapter Xiv",
    "In Which I Arrive",
    "A Grade of C",
  ];
  for (const heading of words) {
    assert.equal(speakHeadingNumerals(heading), null, heading);
  }
});

test("a spoken heading has as many words as the printed one", () => {
  // The synchronizer lights displayed word i for spoken word i, so the
  // count must survive the rewrite; a numeral below a hundred is one token
  // either way ("XXIII" and "twenty-three").
  for (const heading of ["Act III. Scene II.", "Book II, Chapter XXIII", "XCIX", "I —"]) {
    const spoken = speakHeadingNumerals(heading);
    assert.ok(spoken, heading);
    assert.equal(tokenizeWords(spoken).length, tokenizeWords(heading).length, heading);
  }
});
