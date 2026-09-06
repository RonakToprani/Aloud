import "./setup";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePlainText } from "@/lib/epub/parse";
import { peekAutoplay, requestAutoplay, takeAutoplay } from "@/lib/library/autoplay";
import { bookFraction } from "@/lib/library/progress";
import { SAMPLE_AUTHOR, SAMPLE_TEXT, SAMPLE_TITLE } from "@/lib/library/sample";
import { segmentChapter } from "@/lib/text/segment";

describe("the sample book", () => {
  const parsed = parsePlainText(SAMPLE_TEXT, SAMPLE_TITLE);

  it("is one chapter of several paragraphs", () => {
    assert.equal(parsed.chapters.length, 1);
    assert.ok(parsed.chapters[0].blocks.length >= 4, "reads as prose, not one wall of text");
  });

  it("opens on the line people know", () => {
    assert.match(parsed.chapters[0].blocks[0].text, /^Mrs\. Dalloway said she would buy the flowers herself\.$/);
  });

  it("varies its sentence lengths, which is what shows the highlight working", () => {
    const lengths = segmentChapter(parsed.chapters[0]).sentences.map((s) => s.words.length);
    assert.ok(lengths.length >= 8, `expected a handful of sentences, got ${lengths.length}`);
    assert.ok(Math.min(...lengths) <= 4, "needs a short sentence");
    assert.ok(Math.max(...lengths) >= 30, "needs a long one");
  });

  it("is short enough to import in a blink", () => {
    assert.ok(SAMPLE_TEXT.length < 2000, `${SAMPLE_TEXT.length} characters`);
  });

  it("names its author", () => {
    assert.equal(SAMPLE_AUTHOR, "Virginia Woolf");
  });
});

describe("finishing a book", () => {
  const meta = { sentenceCount: 13, chapterSentenceCounts: [13] };

  it("reads as complete once the last sentence is reached", () => {
    assert.equal(bookFraction(meta, 0, 12), 1);
  });

  it("counts sentences finished, not the one being read", () => {
    assert.equal(bookFraction(meta, 0, 0), 0);
    assert.equal(bookFraction(meta, 0, 6), 6 / 13);
  });

  it("carries earlier chapters into the total", () => {
    const many = { sentenceCount: 30, chapterSentenceCounts: [10, 10, 10] };
    assert.equal(bookFraction(many, 1, 5), 15 / 30);
    assert.equal(bookFraction(many, 2, 9), 1, "the last sentence of the last chapter");
  });

  it("survives a book with nothing in it", () => {
    assert.equal(bookFraction({ sentenceCount: 0, chapterSentenceCounts: [] }, 0, 0), 0);
  });
});

describe("a one-sentence book", () => {
  const one = { sentenceCount: 1, chapterSentenceCounts: [1] };

  it("is not finished the moment it is added", () => {
    assert.equal(bookFraction(one, 0, 0), 0);
  });
});

describe("the request to start reading on arrival", () => {
  it("is answered once, for the book that asked", () => {
    requestAutoplay("book-a");
    assert.equal(takeAutoplay("book-a"), true);
    assert.equal(takeAutoplay("book-a"), false, "a second reader does not inherit it");
  });

  it("is spent even when another book reads it, so it cannot fire later", () => {
    requestAutoplay("book-a");
    assert.equal(takeAutoplay("book-b"), false);
    assert.equal(takeAutoplay("book-a"), false, "the stale request is gone, not waiting");
  });

  it("can be seen without being spent", () => {
    requestAutoplay("book-c");
    assert.equal(peekAutoplay("book-c"), true);
    assert.equal(peekAutoplay("book-c"), true, "peeking twice is still true");
    assert.equal(takeAutoplay("book-c"), true);
  });
});
