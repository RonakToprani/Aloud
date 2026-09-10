import assert from "node:assert/strict";
import test from "node:test";
import { trimGutenberg } from "@/lib/gutenberg/trim";
import type { Chapter } from "@/lib/types";

const chapter = (title: string, ...texts: string[]): Chapter => ({
  id: title,
  title,
  blocks: texts.map((text, i) => ({ kind: i === 0 && text === title ? "h1" : "p", text })),
});

const book = (chapters: Chapter[]) => ({ title: "T", author: null, chapters });

test("the Gutenberg front matter and licence come off", () => {
  const trimmed = trimGutenberg(
    book([
      chapter(
        "T",
        "T",
        "The Project Gutenberg eBook of T",
        "This eBook is for the use of anyone anywhere.",
        "*** START OF THE PROJECT GUTENBERG EBOOK T ***",
      ),
      chapter("Chapter I", "Chapter I", "It is a truth universally acknowledged."),
      chapter("Chapter II", "Chapter II", "The end of the story.", "*** END OF THE PROJECT GUTENBERG EBOOK T ***", "START: FULL LICENSE"),
      chapter("THE FULL PROJECT GUTENBERG LICENSE", "THE FULL PROJECT GUTENBERG LICENSE", "PLEASE READ THIS BEFORE YOU DISTRIBUTE."),
    ]),
  );
  assert.deepEqual(
    trimmed.chapters.map((c) => [c.title, c.blocks.map((b) => b.text)]),
    [
      ["Chapter I", ["Chapter I", "It is a truth universally acknowledged."]],
      ["Chapter II", ["Chapter II", "The end of the story."]],
    ],
  );
});

test("a title page after the start marker is kept", () => {
  const trimmed = trimGutenberg(
    book([
      chapter("T", "T", "*** START OF THE PROJECT GUTENBERG EBOOK T ***", "by An Author"),
      chapter("One", "One", "Text."),
    ]),
  );
  assert.equal(trimmed.chapters.length, 2);
  assert.deepEqual(trimmed.chapters[0].blocks.map((b) => b.text), ["by An Author"]);
});

test("notes about the file just inside the marker come off too", () => {
  const trimmed = trimGutenberg(
    book([
      chapter(
        "T",
        "T",
        "*** START OF THE PROJECT GUTENBERG EBOOK T ***",
        "THERE IS AN ILLUSTRATED EDITION OF THIS TITLE WHICH MAY VIEWED AT EBOOK [ #48320 ]",
        "Produced by Volunteers.",
        "by An Author",
      ),
      chapter("One", "One", "Text."),
    ]),
  );
  assert.deepEqual(trimmed.chapters[0].blocks.map((b) => b.text), ["by An Author"]);
});

test("a book without markers is left alone", () => {
  const original = book([chapter("One", "One", "Text.")]);
  assert.deepEqual(trimGutenberg(original), original);
});

test("markers that leave nothing behind leave the book whole", () => {
  const original = book([chapter("T", "T", "*** START OF THE PROJECT GUTENBERG EBOOK T ***", "*** END OF THE PROJECT GUTENBERG EBOOK T ***")]);
  assert.deepEqual(trimGutenberg(original), original);
});
