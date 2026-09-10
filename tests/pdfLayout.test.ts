import assert from "node:assert/strict";
import test from "node:test";
import { layoutPdf, type PdfPageText, type PdfTextItem } from "@/lib/pdf/layout";

/* A page of a made-up book, in the coordinates pdf.js hands over: x to the
   right, y downward from the top. Nothing here goes near a real PDF, so the
   geometry can be stated exactly. */

const SIZE = 12;
const LEADING = 15;
const LEFT = 72;
const RIGHT = 468;

interface LineSpec {
  text: string;
  y: number;
  /** Defaults to the left margin. */
  x?: number;
  size?: number;
  /** Share of the column the line fills. Defaults to a full measure. */
  fill?: number;
  font?: string;
}

function page(index: number, lines: LineSpec[], width = 540, height = 720): PdfPageText {
  const items: PdfTextItem[] = lines.map((line) => {
    const size = line.size ?? SIZE;
    const x = line.x ?? LEFT;
    return {
      str: line.text,
      x,
      y: line.y,
      width: (line.fill ?? 1) * (RIGHT - x),
      size,
      font: line.font ?? "body",
    };
  });
  return { index, width, height, items };
}

/** Consecutive lines down the page from a starting y. */
function column(start: number, lines: Omit<LineSpec, "y">[], leading = LEADING): LineSpec[] {
  return lines.map((line, i) => ({ ...line, y: start + i * leading }));
}

const texts = (pages: PdfPageText[]) => layoutPdf(pages).blocks.map((entry) => entry.block.text);
const kinds = (pages: PdfPageText[]) => layoutPdf(pages).blocks.map((entry) => entry.block.kind);

test("wrapped lines become one paragraph", () => {
  const body = column(100, [
    { text: "It was a bright cold day in April," },
    { text: "and the clocks were striking" },
    { text: "thirteen.", fill: 0.2 },
  ]);
  assert.deepEqual(texts([page(0, body)]), [
    "It was a bright cold day in April, and the clocks were striking thirteen.",
  ]);
});

test("an indent starts a new paragraph", () => {
  const body = column(100, [
    { text: "The first paragraph runs on for a" },
    { text: "line or two and then it ends.", fill: 0.6 },
    { text: "The second one begins here,", x: LEFT + 18 },
    { text: "indented as printed books do it.", fill: 0.5 },
  ]);
  assert.deepEqual(texts([page(0, body)]), [
    "The first paragraph runs on for a line or two and then it ends.",
    "The second one begins here, indented as printed books do it.",
  ]);
});

test("a blank line's worth of space starts a new paragraph", () => {
  const lines: LineSpec[] = [
    ...column(100, [
      { text: "One paragraph, flush left and" },
      { text: "unindented, running to three" },
      { text: "lines and no further." },
    ]),
    ...column(100 + 3 * LEADING + 14, [
      { text: "Another, after a blank line," },
      { text: "of much the same length as the" },
      { text: "one before it was." },
    ]),
  ];
  assert.deepEqual(texts([page(0, lines)]), [
    "One paragraph, flush left and unindented, running to three lines and no further.",
    "Another, after a blank line, of much the same length as the one before it was.",
  ]);
});

test("a book that marks nothing falls back to lines that stop short", () => {
  // No indents and no blank lines: the only evidence a paragraph ended is
  // the last line of it not reaching the margin.
  const body = column(100, [
    { text: "A paragraph set flush left with no" },
    { text: "blank line after it at all.", fill: 0.4 },
    { text: "The next one starts here and also" },
    { text: "runs to two lines.", fill: 0.3 },
  ]);
  assert.deepEqual(texts([page(0, body)]), [
    "A paragraph set flush left with no blank line after it at all.",
    "The next one starts here and also runs to two lines.",
  ]);
});

test("ragged line ends alone do not split a paragraph", () => {
  // The same wrapped sentence, unjustified, in a book that does indent. Each
  // line falls a word short of the margin, which must not read as an ending.
  const body = [
    ...column(100, [
      { text: "Ragged right, so every line stops", fill: 0.88 },
      { text: "a little short of the margin", fill: 0.84 },
      { text: "without ending anything.", fill: 0.86 },
    ]),
    ...column(100 + 3 * LEADING, [
      { text: "A properly indented paragraph", x: LEFT + 18 },
      { text: "follows it.", fill: 0.2 },
    ]),
  ];
  assert.deepEqual(texts([page(0, body)]), [
    "Ragged right, so every line stops a little short of the margin without ending anything.",
    "A properly indented paragraph follows it.",
  ]);
});

test("a paragraph runs on across a page turn", () => {
  const first = page(0, column(600, [{ text: "The sentence begins on one page" }]));
  const second = page(1, column(100, [{ text: "and finishes on the next.", fill: 0.4 }]));
  assert.deepEqual(texts([first, second]), ["The sentence begins on one page and finishes on the next."]);
});

test("a page that ended a paragraph does not run on", () => {
  const first = page(0, column(600, [{ text: "This page ends here.", fill: 0.3 }]));
  const second = page(1, column(100, [{ text: "A new thought starts overleaf.", fill: 0.5 }]));
  assert.deepEqual(texts([first, second]), ["This page ends here.", "A new thought starts overleaf."]);
});

test("a word broken over a line break is put back together", () => {
  const body = column(100, [
    { text: "The wind was altogether unremark-" },
    { text: "able that morning.", fill: 0.4 },
  ]);
  assert.deepEqual(texts([page(0, body)]), ["The wind was altogether unremarkable that morning."]);
});

test("a hyphenated compound at a line end keeps its hyphen", () => {
  const body = column(100, [
    { text: "She lived in a well-" },
    { text: "Kept house.", fill: 0.4 },
  ]);
  // The next line starting with a capital says the hyphen was not a break.
  assert.deepEqual(texts([page(0, body)]), ["She lived in a well- Kept house."]);
});

test("bigger type is a heading", () => {
  const lines: LineSpec[] = [
    { text: "Chapter One", y: 80, size: 24, fill: 0.4 },
    ...column(140, [{ text: "It was a bright cold day in April.", fill: 0.5 }]),
  ];
  assert.deepEqual(kinds([page(0, lines)]), ["h1", "p"]);
});

test("a heading set over two lines is one heading", () => {
  const lines: LineSpec[] = [
    { text: "CHAPTER ONE", y: 80, size: 20, fill: 0.4 },
    { text: "The Boy Who Lived", y: 108, size: 20, fill: 0.5 },
    ...column(160, [{ text: "Mr and Mrs Dursley were perfectly normal.", fill: 0.6 }]),
  ];
  const blocks = layoutPdf([page(0, lines)]).blocks.map((entry) => entry.block);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, "CHAPTER ONE: The Boy Who Lived");
  assert.equal(blocks[1].kind, "p");
});

test("two numbered headings in a row stay two headings", () => {
  const lines: LineSpec[] = [
    { text: "Chapter One", y: 80, size: 20, fill: 0.4 },
    { text: "Chapter Two", y: 108, size: 20, fill: 0.4 },
    ...column(160, [{ text: "Body text so there is a body size at all.", fill: 0.6 }]),
  ];
  const blocks = layoutPdf([page(0, lines)]).blocks.map((entry) => entry.block);
  assert.deepEqual(
    blocks.map((block) => block.text),
    ["Chapter One", "Chapter Two", "Body text so there is a body size at all."],
  );
});

test("a running head and a page number are not read", () => {
  const pages = [0, 1, 2, 3].map((index) =>
    page(index, [
      { text: "NINETEEN EIGHTY-FOUR", y: 30, size: 9, fill: 0.4 },
      ...column(120, [
        { text: `Body of page ${index + 1}, which runs the full` },
        { text: "measure and then stops.", fill: 0.4 },
      ]),
      { text: String(index + 1), y: 700, size: 9, fill: 0.02 },
    ]),
  );
  assert.deepEqual(
    texts(pages),
    [1, 2, 3, 4].map((n) => `Body of page ${n}, which runs the full measure and then stops.`),
  );
});

test("a running head that changes every page is still not read", () => {
  // Verso and recto often carry different heads, so neither is on every page.
  const pages = [0, 1, 2, 3, 4, 5, 6, 7].map((index) =>
    page(index, [
      { text: index % 2 === 0 ? "George Orwell" : "Nineteen Eighty-Four", y: 30, size: 9, fill: 0.3 },
      ...column(120, [
        { text: `Page ${index + 1} says its piece across the` },
        { text: "full measure, and then ends.", fill: 0.4 },
      ]),
    ]),
  );
  assert.deepEqual(
    texts(pages),
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `Page ${n} says its piece across the full measure, and then ends.`),
  );
});

test("two columns read down one and then the other", () => {
  const at = (x: number, texts: string[]): PdfTextItem[] =>
    texts.map((text, i) => ({ str: text, x, y: 100 + i * LEADING, width: 200, size: SIZE, font: "body" }));

  const items = [
    ...at(40, ["The left column runs", "from the top of the page", "to the bottom of it."]),
    ...at(300, ["And only then does the", "right one begin, which is", "how a paper is read."]),
  ];
  // The last line of each column stops short, which is what ends it.
  items[2].width = 100;
  items[5].width = 100;

  assert.deepEqual(texts([{ index: 0, width: 540, height: 720, items }]), [
    "The left column runs from the top of the page to the bottom of it.",
    "And only then does the right one begin, which is how a paper is read.",
  ]);
});

test("a contents page is skipped", () => {
  const contents = page(0, [
    { text: "Contents", y: 80, size: 18, fill: 0.2 },
    ...column(140, [
      { text: "Chapter One", fill: 0.3 },
      { text: "Chapter Two", fill: 0.3 },
      { text: "Chapter Three", fill: 0.3 },
      { text: "Chapter Four", fill: 0.3 },
    ]),
  ]);
  const body = page(1, column(100, [{ text: "The book itself starts here.", fill: 0.4 }]));
  assert.deepEqual(texts([contents, body]), ["The book itself starts here."]);
});

test("a contents page laid out with leader dots is skipped too", () => {
  const contents = page(0, [
    ...column(140, [
      { text: "Mechanics of futures markets ..................... 2", fill: 0.9 },
      { text: "Hedging strategies using futures ................. 3", fill: 0.9 },
      { text: "Interest rates ................................... 4", fill: 0.9 },
      { text: "Determination of forward prices .................. 5", fill: 0.9 },
      { text: "Interest rate futures ............................ 6", fill: 0.9 },
    ]),
  ]);
  const body = [1, 2, 3, 4, 5, 6].map((n) =>
    page(n, column(100, [{ text: `Page ${n} of the book itself, which runs the full` }, { text: "measure and then stops.", fill: 0.4 }])),
  );
  assert.deepEqual(
    texts([contents, ...body]),
    [1, 2, 3, 4, 5, 6].map((n) => `Page ${n} of the book itself, which runs the full measure and then stops.`),
  );
});

test("a page in the middle of a contents list goes with it", () => {
  const entries = (from: number) =>
    column(140, [0, 1, 2, 3, 4, 5].map((n) => ({ text: `A chapter of the book ......... ${from + n}`, fill: 0.9 })));
  // The middle page carries chapter names too long to leave room for their
  // numbers, so nothing on it says "contents" on its own.
  const middle = page(1, column(140, [
    { text: "A chapter whose name fills the whole measure and leaves no room", fill: 0.95 },
    { text: "Another chapter whose name does the same thing again over here", fill: 0.95 },
  ]));
  const body = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) =>
    page(n, column(100, [{ text: `Page ${n} runs the whole measure across` }, { text: "and then stops.", fill: 0.3 }])),
  );

  const said = texts([page(0, entries(4)), middle, page(2, entries(10)), ...body]);
  assert.ok(!said.some((text) => text.includes("A chapter")), said.slice(0, 2).join(" | "));
  assert.equal(said.length, body.length);
});

test("a figure's axis labels are not a contents page", () => {
  // Numbers going down the page, and larger than the book has pages: an
  // axis, not a list of chapters.
  const figure = page(0, [
    ...column(100, [{ text: "Figure 23.1 The index from 2005 to 2010.", fill: 0.6 }]),
    ...column(140, [
      { text: "1800", x: 40, fill: 0.05 },
      { text: "1600", x: 40, fill: 0.05 },
      { text: "1400", x: 40, fill: 0.05 },
      { text: "1200", x: 40, fill: 0.05 },
      { text: "1000", x: 40, fill: 0.05 },
    ]),
  ]);
  assert.ok(texts([figure]).some((text) => text.includes("Figure 23.1")));
});

test("an empty page contributes nothing and breaks nothing", () => {
  const blank: PdfPageText = { index: 0, width: 540, height: 720, items: [] };
  const body = page(1, column(100, [{ text: "Only this is read.", fill: 0.3 }]));
  assert.deepEqual(texts([blank, body]), ["Only this is read."]);
});

test("a column of nothing but leader dots is dropped", () => {
  const lines: LineSpec[] = [
    ...column(100, [{ text: "A real sentence to carry the body size.", fill: 0.6 }]),
    { text: ". . . . . . . .", y: 200, fill: 0.4 },
  ];
  assert.deepEqual(texts([page(0, lines)]), ["A real sentence to carry the body size."]);
});
