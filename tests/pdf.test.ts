import assert from "node:assert/strict";
import test from "node:test";
import { parsePdf, PdfParseError } from "@/lib/pdf/parse";
import { makePdf, wrap, type PdfLineSpec, type PdfPageSpec } from "./makePdf";

/* Real PDFs, through pdf.js, the way a reader's browser does it. The pages
   are built the way a typesetter would: a measure, a leading, an indent. */

const LEFT = 72;
const TOP = 700;
const SIZE = 12;
const LEADING = 16;
const MEASURE = 400;

/** A paragraph, wrapped, with the indent a printed book gives it. */
function paragraph(text: string, top: number, indent = 18): { lines: PdfLineSpec[]; next: number } {
  const lines = wrap(text, { x: LEFT, top, size: SIZE, leading: LEADING, columnWidth: MEASURE });
  if (lines.length) lines[0] = { ...lines[0], x: LEFT + indent };
  return { lines, next: top - lines.length * LEADING };
}

function bodyPage(paragraphs: string[], extra: PdfLineSpec[] = []): PdfPageSpec {
  const lines: PdfLineSpec[] = [...extra];
  let top = TOP;
  for (const text of paragraphs) {
    const laid = paragraph(text, top);
    lines.push(...laid.lines);
    top = laid.next;
  }
  return { lines };
}

const SENTENCES = [
  "It was a bright cold day in April, and the clocks were striking thirteen, which was the sort of thing that happened in that country now.",
  "Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly through the glass doors of Victory Mansions.",
  "The hallway smelt of boiled cabbage and old rag mats, and at one end of it a coloured poster had been tacked to the wall.",
];

const text = (book: Awaited<ReturnType<typeof parsePdf>>) =>
  book.chapters.flatMap((chapter) => chapter.blocks.map((block) => block.text));

test("a PDF becomes chapters and paragraphs", async () => {
  const book = await parsePdf(makePdf([bodyPage(SENTENCES)]), "Fallback");
  assert.equal(book.chapters.length, 1);
  const paragraphs = book.chapters[0].blocks.filter((block) => block.kind === "p");
  assert.deepEqual(paragraphs.map((block) => block.text), SENTENCES);
});

test("the title and author come from the file's own metadata", async () => {
  const book = await parsePdf(
    makePdf([bodyPage(SENTENCES)], { title: "Nineteen Eighty-Four", author: "George Orwell" }),
    "Fallback",
  );
  assert.equal(book.title, "Nineteen Eighty-Four");
  assert.equal(book.author, "George Orwell");
});

test("a producer's idea of a title is not used", async () => {
  const book = await parsePdf(makePdf([bodyPage(SENTENCES)], { title: "Microsoft Word - draft7.doc" }), "Fallback");
  assert.equal(book.title, "draft7");
});

test("a file with no metadata falls back to the name it was given", async () => {
  const book = await parsePdf(makePdf([bodyPage(SENTENCES)]), "Some Book");
  assert.equal(book.title, "Some Book");
});

test("the outline becomes the chapters", async () => {
  const pdf = makePdf(
    [bodyPage(SENTENCES), bodyPage(SENTENCES), bodyPage(SENTENCES)],
    {
      title: "A Book",
      outline: [
        { title: "The Window", page: 0 },
        { title: "Time Passes", page: 1 },
        { title: "The Lighthouse", page: 2 },
      ],
    },
  );
  const book = await parsePdf(pdf, "Fallback");
  assert.deepEqual(book.chapters.map((chapter) => chapter.title), [
    "The Window",
    "Time Passes",
    "The Lighthouse",
  ]);
  // Each chapter opens with its own name, the way an EPUB chapter does.
  for (const chapter of book.chapters) {
    assert.equal(chapter.blocks[0].kind, "h1");
    assert.equal(chapter.blocks[0].text, chapter.title);
  }
});

test("without an outline, chapter headings are found in the type", async () => {
  const heading = (title: string): PdfLineSpec[] => [
    { x: LEFT, y: TOP + 40, size: 22, text: title, bold: true },
  ];
  const pdf = makePdf([
    { lines: [...heading("Chapter One"), ...bodyPage(SENTENCES).lines] },
    { lines: [...heading("Chapter Two"), ...bodyPage(SENTENCES).lines] },
  ]);
  const book = await parsePdf(pdf, "Fallback");
  assert.deepEqual(book.chapters.map((chapter) => chapter.title), ["Chapter One", "Chapter Two"]);
});

test("outline entries landing on one page make one chapter, named by the last", async () => {
  // A contents list and the chapter after it often point at the same place
  // once the contents pages themselves have been dropped.
  const pdf = makePdf([bodyPage(SENTENCES), bodyPage(SENTENCES), bodyPage(SENTENCES)], {
    outline: [
      { title: "Front matter", page: 0 },
      { title: "Contents", page: 1 },
      { title: "Chapter One", page: 1 },
      { title: "Chapter Two", page: 2 },
    ],
  });
  const book = await parsePdf(pdf, "Fallback");
  assert.deepEqual(book.chapters.map((chapter) => chapter.title), [
    "Front matter",
    "Chapter One",
    "Chapter Two",
  ]);
});

test("a running head and a page number are left out of the reading", async () => {
  const pages = [0, 1, 2, 3].map((index) =>
    bodyPage(SENTENCES, [
      { x: LEFT, y: 760, size: 9, text: "NINETEEN EIGHTY-FOUR" },
      { x: 300, y: 40, size: 9, text: String(index + 1) },
    ]),
  );
  const book = await parsePdf(makePdf(pages), "Fallback");
  const said = text(book).join(" ");
  assert.ok(!said.includes("NINETEEN EIGHTY-FOUR"), said.slice(0, 200));
  assert.ok(!/\bpage\b/i.test(said));
});

test("a paragraph split by a page turn is read as one", async () => {
  const long = SENTENCES.join(" ");
  const all = wrap(long, { x: LEFT, top: TOP, size: SIZE, leading: LEADING, columnWidth: MEASURE });
  const half = Math.ceil(all.length / 2);
  const pdf = makePdf([
    { lines: all.slice(0, half) },
    { lines: all.slice(half).map((line, i) => ({ ...line, y: TOP - i * LEADING })) },
  ]);
  const book = await parsePdf(pdf, "Fallback");
  const paragraphs = book.chapters[0].blocks.filter((block) => block.kind === "p");
  assert.equal(paragraphs.length, 1);
  assert.equal(paragraphs[0].text, long);
});

test("a PDF with no text at all says it is probably a scan", async () => {
  await assert.rejects(
    () => parsePdf(makePdf([{ lines: [] }]), "Fallback"),
    (error: unknown) => error instanceof PdfParseError && /scan/i.test((error as Error).message),
  );
});

test("something that is not a PDF says so", async () => {
  await assert.rejects(
    () => parsePdf(new TextEncoder().encode("this is not a pdf at all"), "Fallback"),
    (error: unknown) =>
      error instanceof PdfParseError && /damaged|renamed|readable/i.test((error as Error).message),
  );
});

test("the caller's buffer survives being parsed", async () => {
  // pdf.js takes ownership of what it is handed, and the library screen may
  // still want the file afterwards.
  const bytes = makePdf([bodyPage(SENTENCES)]);
  const before = bytes.byteLength;
  await parsePdf(bytes, "Fallback");
  assert.equal(bytes.byteLength, before);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 5)), "%PDF-");
});

test("progress runs from nothing to done", async () => {
  const seen: number[] = [];
  await parsePdf(makePdf([bodyPage(SENTENCES), bodyPage(SENTENCES)]), "Fallback", (fraction) =>
    seen.push(fraction),
  );
  assert.ok(seen.length >= 2);
  assert.equal(seen[seen.length - 1], 1);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1]);
});
