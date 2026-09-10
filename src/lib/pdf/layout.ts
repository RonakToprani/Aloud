/**
 * A PDF has no paragraphs. It has glyphs at coordinates, and the shape of a
 * paragraph has to be inferred back out of them: which runs share a line,
 * which lines belong to one paragraph, which lines are the running head that
 * repeats on every page and should never be read aloud.
 *
 * Everything here is geometry over already-extracted text, so it runs and is
 * tested without a PDF anywhere near it.
 */

import type { Block, BlockKind } from "@/lib/types";
import { bareHeading, clean, isAllCaps, isChapterHeading } from "@/lib/text/headings";

/** One run of text as pdf.js hands it over, in device space: x to the right,
 *  y downward from the top of the page, page rotation already applied. */
export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  /** Rendered width, so the right edge of a line is known. */
  width: number;
  /** Font size in the same units as x and y. */
  size: number;
  /** pdf.js font id: opaque, but stable, so one face can be told from another. */
  font: string;
}

export interface PdfPageText {
  /** Zero-based. */
  index: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

export interface PdfLine {
  page: number;
  text: string;
  x: number;
  right: number;
  y: number;
  size: number;
  font: string;
  /** In the band a running head or a page number lives in. */
  margin: boolean;
}

/** A block and the page it began on, so chapters can be cut at page bounds. */
export interface LaidOutBlock {
  block: Block;
  page: number;
}

/** One measure the text is set to: where an unindented line starts and
 *  where a full line reaches. */
export interface Column {
  left: number;
  right: number;
}

export interface LayoutMetrics {
  /** Size the body of the book is set in. */
  bodySize: number;
  /** Distance between consecutive baselines within a paragraph. */
  leading: number;
  /** Left to right across the page. One for a book, two for a paper. */
  columns: Column[];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

/** The key the most characters were counted under, which picks the body size
 *  even in a book whose headings outnumber its paragraphs. */
function dominant(weights: Map<string, number>): string {
  let best = "";
  let most = -1;
  for (const [key, weight] of weights) {
    if (weight > most) {
      most = weight;
      best = key;
    }
  }
  return best;
}

const sizeKey = (size: number) => String(Math.round(size * 2) / 2);

/* ------------------------------------------------------------------ lines */

/** Runs sharing a baseline, split wherever a gap is wide enough to be a
 *  gutter or a table column rather than a word space. */
function groupIntoLines(page: PdfPageText): PdfLine[] {
  const items = page.items.filter((item) => item.str.trim().length > 0);
  if (!items.length) return [];

  const typical = median(items.map((item) => item.size).filter((size) => size > 0)) || 12;
  // Superscripts and inline maths sit a little off the line, so what counts
  // as the same baseline is a fraction of the type size.
  const tolerance = Math.max(1, typical * 0.4);

  const rows: PdfTextItem[][] = [];
  for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(item.y - row[0].y) <= tolerance) row.push(item);
    else rows.push([item]);
  }

  const lines: PdfLine[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let run: PdfTextItem[] = [];
    const flush = () => {
      if (run.length) lines.push(makeLine(run, page));
      run = [];
    };
    for (const item of row) {
      const previous = run[run.length - 1];
      if (previous) {
        const gap = item.x - (previous.x + previous.width);
        // A word space is about a quarter of the type size. This is a
        // gutter, a table column, or the leader dots in a contents list.
        if (gap > Math.max(item.size * 3, page.width * 0.06)) flush();
      }
      run.push(item);
    }
    flush();
  }
  return lines;
}

function makeLine(run: PdfTextItem[], page: PdfPageText): PdfLine {
  const sizes = new Map<string, number>();
  const fonts = new Map<string, number>();
  let text = "";

  for (let i = 0; i < run.length; i++) {
    const item = run[i];
    const str = untrack(item.str);
    const chars = str.trim().length || 1;
    sizes.set(sizeKey(item.size), (sizes.get(sizeKey(item.size)) ?? 0) + chars);
    fonts.set(item.font, (fonts.get(item.font) ?? 0) + chars);

    const previous = run[i - 1];
    if (previous && text && !/\s$/.test(text) && !/^\s/.test(str)) {
      // pdf.js breaks a line at every font change and every kerning
      // adjustment, so most joins are mid-word. The space glyph itself
      // carries no text, so a space here is a gap and nothing else.
      const gap = item.x - (previous.x + previous.width);
      if (gap > Math.max(previous.size, item.size) * 0.18) text += " ";
    }
    text += str;
  }

  const last = run[run.length - 1];
  const y = run[0].y;
  return {
    page: page.index,
    text: clean(text),
    x: run[0].x,
    right: last.x + last.width,
    y,
    size: Number(dominant(sizes)) || run[0].size,
    font: dominant(fonts),
    margin: y < page.height * 0.08 || y > page.height * 0.92,
  };
}

/**
 * A T I T L E   S E T   L I K E   T H I S is stored letter by letter, and
 * pdf.js faithfully turns the tracking between the letters into spaces. Read
 * aloud that is a chapter title spelled out, so the spaces inside such a run
 * come back out. The run's own boundaries are the real word boundaries,
 * which is why this works on one text item at a time and not on the line.
 */
const TRACKED = /^\p{L}(?: \p{L}){2,}$/u;

function untrack(str: string): string {
  const core = str.trim();
  if (!TRACKED.test(core)) return str;
  return str.replace(core, core.replace(/ /g, ""));
}

/** Two-column pages read down one column and then the other, not across.
 *  Returns the x of the gutter, or null when the page is one column. */
function findGutter(lines: PdfLine[], width: number): number | null {
  if (lines.length < 6) return null;
  for (let fraction = 0.42; fraction <= 0.58; fraction += 0.02) {
    const gutter = width * fraction;
    let left = 0;
    let right = 0;
    let across = 0;
    for (const line of lines) {
      if (line.right <= gutter) left++;
      else if (line.x >= gutter) right++;
      else across++;
    }
    // A running head or a full-width title may cross the gutter. A body of
    // text may not, or it was never two columns.
    const crossings = Math.max(1, lines.length * 0.08);
    if (across <= crossings && left >= lines.length * 0.25 && right >= lines.length * 0.25) return gutter;
  }
  return null;
}

const byPosition = (a: PdfLine, b: PdfLine) => a.y - b.y || a.x - b.x;

/**
 * Every line of one page, in reading order.
 *
 * Exported so a book can be read a page at a time: nine hundred pages of
 * text runs is a million objects held at once, and the lines they collapse
 * into are a tenth of that. The caller keeps these and lets the runs go.
 */
export function pageLines(page: PdfPageText): PdfLine[] {
  const lines = groupIntoLines(page);
  const gutter = findGutter(lines, page.width);
  if (gutter === null) return lines.sort(byPosition);

  // A full-width heading sits above both columns, so it is read first.
  const across = lines.filter((line) => line.x < gutter && line.right > gutter);
  const left = lines.filter((line) => line.right <= gutter);
  const right = lines.filter((line) => line.x >= gutter);
  return [...across.sort(byPosition), ...left.sort(byPosition), ...right.sort(byPosition)];
}

/* -------------------------------------------------- running heads and feet */

/** "Page 12 of 400" and "Page 13 of 400" differ only in the numbers, so
 *  lines are compared with their digits blanked out. */
const shape = (text: string) => text.replace(/\d+/g, "#").toLowerCase().trim();

/** A folio: a number, or a roman numeral that is actually one. Spelled out
 *  loosely, "MILD" and "CIVIL" are roman numerals and get read as page
 *  numbers, and the words go missing from the book. */
const PAGE_NUMBER = /^[[(]?(?:page\s*)?(?=[\dIVXLCDM])(?:\d{1,4}|M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{1,3}|I?V)?)[\])]?$/i;

/**
 * Drop the furniture. A line in the margin band saying the same thing on
 * many pages is a running head; a line in the margin band that is only a
 * number is a page number even though it says something new every time.
 */
function stripFurniture(pages: PdfLine[][]): PdfLine[][] {
  const seenOn = new Map<string, Set<number>>();
  for (const lines of pages) {
    for (const line of lines) {
      if (!line.margin) continue;
      const key = shape(line.text);
      if (!key) continue;
      let pagesWithIt = seenOn.get(key);
      if (!pagesWithIt) seenOn.set(key, (pagesWithIt = new Set()));
      pagesWithIt.add(line.page);
    }
  }

  // Four pages, not a share of the book: a textbook changes its running head
  // at every chapter, so no one head reaches even a few percent of a long
  // one. Four pages carrying the same line in the same margin is furniture
  // whether the book is ten pages or nine hundred.
  const repeated = new Set(
    [...seenOn.entries()].filter(([, pagesWithIt]) => pagesWithIt.size >= 4).map(([key]) => key),
  );

  return pages.map((lines) =>
    lines.filter((line) => {
      if (!line.margin) return true;
      if (PAGE_NUMBER.test(line.text)) return false;
      return !repeated.has(shape(line.text));
    }),
  );
}

/** A run of leader dots, a rule drawn out of full stops, a stray bullet: no
 *  letters and no digits, so nothing to say. */
const UNREADABLE = /^[^\p{L}\p{N}]+$/u;

const CONTENTS_TITLE = /^(table of )?contents$/i;

/** "Measuring interest rates ................ 79" — a name, leader dots, and
 *  the page it is on. */
const CONTENTS_ENTRY = /[.·]{3,}\s*(\d{1,4})$/;

/** Longer than a name and a page number, so it is a line of a book. */
const PROSE = 80;

/**
 * A contents page is chapter names against page numbers. Read aloud it is a
 * list of numbers, and the reader has a contents list of its own, so the
 * whole page goes.
 *
 * The hard part is not finding one. It is not throwing away a page of a book
 * that happens to have numbers on it: a figure's axis labels, a table, a
 * numbered list of exercises. So the numbers have to behave like page
 * numbers — pages this book has, going up as the list goes down — and there
 * has to be no prose on the page at all.
 */
function isContentsPage(lines: PdfLine[], pageCount: number): boolean {
  if (lines.length < 5) return false;
  if (lines.some((line) => CONTENTS_TITLE.test(line.text))) return true;

  // Measured without the leader dots, which are padding and not words: a
  // contents entry runs the full measure and says twenty characters.
  const prose = lines.filter((line) => line.text.replace(/[.·]{3,}/g, "").length > PROSE);
  if (prose.length > lines.length * 0.25) return false;

  // Right-aligned page numbers arrive as lines of their own, because the gap
  // before them is wide enough to be a gutter. Leader dots keep them
  // attached. Either way, a page that is mostly these is a contents page.
  const folios: number[] = [];
  for (const line of lines) {
    if (line.margin) continue;
    const match = /^(\d{1,4})$/.exec(line.text) ?? CONTENTS_ENTRY.exec(line.text);
    if (match) folios.push(Number(match[1]));
  }
  if (folios.length < 4 || folios.length < lines.length * 0.25) return false;
  if (folios.some((folio) => folio < 1 || folio > pageCount)) return false;
  // A contents list never sends you to the same page four times. A page of
  // equations says "2" over and over.
  if (new Set(folios).size < folios.length * 0.8) return false;

  let rising = 0;
  for (let i = 1; i < folios.length; i++) if (folios[i] >= folios[i - 1]) rising++;
  return rising >= (folios.length - 1) * 0.8;
}

/**
 * A contents list runs over several pages, and one of them may be a spread
 * of long chapter names with no page numbers reaching the right margin. A
 * page sitting between two contents pages is one too.
 */
function bridgeContents(flags: boolean[]): boolean[] {
  const out = [...flags];
  for (let i = 0; i < out.length; i++) {
    if (out[i]) continue;
    let before = false;
    for (let j = i - 1; j >= i - 2 && j >= 0; j--) if (flags[j]) before = true;
    let after = false;
    for (let j = i + 1; j <= i + 2 && j < flags.length; j++) if (flags[j]) after = true;
    out[i] = before && after;
  }
  return out;
}

/* ------------------------------------------------------------------ blocks */

export function measure(lines: PdfLine[]): LayoutMetrics {
  const sizes = new Map<string, number>();
  for (const line of lines) sizes.set(sizeKey(line.size), (sizes.get(sizeKey(line.size)) ?? 0) + line.text.length);
  const bodySize = Number(dominant(sizes)) || 12;

  const body = lines.filter((line) => Math.abs(line.size - bodySize) < 0.6);
  const sample = body.length >= 4 ? body : lines;

  const gaps: number[] = [];
  for (let i = 1; i < sample.length; i++) {
    if (sample[i].page !== sample[i - 1].page) continue;
    const gap = sample[i].y - sample[i - 1].y;
    if (gap > 0.2 && gap < bodySize * 3) gaps.push(gap);
  }

  return { bodySize, leading: median(gaps) || bodySize * 1.2, columns: findColumns(sample, bodySize) };
}

/**
 * The measures the text is set to. A book has one; a paper has two, and on a
 * paper the left edge of the second column is a margin, not an indent, which
 * is the whole reason this is a list.
 */
function findColumns(sample: PdfLine[], bodySize: number): Column[] {
  const bucket = Math.max(2, bodySize * 0.5);
  const counts = new Map<number, number>();
  for (const line of sample) {
    const key = Math.round(line.x / bucket);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  // A left edge only a few lines start at is a pulled-out quotation or a
  // stray mark in the margin, not a measure the book is set to.
  const enough = Math.max(3, sample.length * 0.06);
  const candidates = [...counts.entries()]
    .filter(([, count]) => count >= enough)
    .map(([key]) => key * bucket)
    .sort((a, b) => a - b);

  // An indent is a couple of ems and belongs to the measure it sits inside.
  // A gutter is a fifth of the page, so nothing merges across one.
  const lefts: number[] = [];
  for (const left of candidates) {
    if (lefts.length && left - lefts[lefts.length - 1] <= bodySize * 4) continue;
    lefts.push(left);
  }
  if (!lefts.length) {
    // Too little text for any edge to be a measure: fall back to the tenth
    // percentile of where lines start, which a stray mark cannot move.
    const sorted = sample.map((line) => line.x).sort((a, b) => a - b);
    lefts.push(sorted[Math.floor(sorted.length * 0.1)] ?? 0);
  }

  return lefts.map((left, index) => {
    const next = lefts[index + 1] ?? Infinity;
    const rights = sample
      .filter((line) => line.x >= left - bodySize && line.x < next - bodySize)
      .map((line) => line.right)
      .sort((a, b) => b - a);
    // The tenth longest line in a hundred, not the longest: one line running
    // into the margin must not move the margin.
    return { left, right: rights[Math.floor(rights.length * 0.1)] ?? left };
  });
}

/** A line whose type is bigger than the body, or that reads like a title. */
function headingKind(line: PdfLine, metrics: LayoutMetrics, bodyFont: string): BlockKind | null {
  const words = line.text.split(/\s+/).filter(Boolean);
  if (!words.length) return null;

  const ratio = line.size / metrics.bodySize;
  const short = line.text.length <= 90 && words.length <= 14;
  if (ratio >= 1.55 && short) return "h1";
  if (ratio >= 1.2 && short) return "h2";
  if (ratio >= 1.08 && short && words.length <= 8) return "h3";

  // Set in the body face at the body size: only the wording, or a face used
  // nowhere else in the book, can say this is a heading.
  if (!short || words.length > 8 || ratio < 0.98) return null;
  if (isChapterHeading(line.text)) return "h2";
  if (/[.!?,;:]$/.test(line.text)) return null;
  if (isAllCaps(line.text)) return "h2";
  if (line.font !== bodyFont) return "h3";
  return null;
}

/** A word broken across a line break, which has to be put back together. */
const HYPHEN_END = /\p{Ll}\p{L}[-‐]$/u;

function joinWrapped(previous: string, next: string): string {
  if (HYPHEN_END.test(previous) && /^\p{Ll}/u.test(next)) return `${previous.slice(0, -1)}${next}`;
  return `${previous} ${next}`;
}

const ENDS_SENTENCE = /[.!?…"'”’)\]]$/;

/**
 * Lines in, paragraphs out. A new paragraph begins where a printed book says
 * one begins: an indent, a blank line's worth of space, or a previous line
 * that stopped short of the right margin.
 */
export function layoutPdf(pages: PdfPageText[]): { blocks: LaidOutBlock[]; metrics: LayoutMetrics } {
  return layoutLines(pages.map(pageLines));
}

/** The same, for a caller that has already turned its pages into lines. */
export function layoutLines(pages: PdfLine[][]): { blocks: LaidOutBlock[]; metrics: LayoutMetrics } {
  const stripped = stripFurniture(pages);
  const contents = bridgeContents(stripped.map((page) => isContentsPage(page, pages.length)));
  const lines = stripped
    .filter((_, page) => !contents[page])
    .flat()
    .filter((line) => line.text && !UNREADABLE.test(line.text));
  const metrics = measure(lines);

  const fonts = new Map<string, number>();
  for (const line of lines) {
    if (Math.abs(line.size - metrics.bodySize) > 0.6) continue;
    fonts.set(line.font, (fonts.get(line.font) ?? 0) + line.text.length);
  }
  const bodyFont = dominant(fonts);

  /** Which measure a line is set in. */
  const columnOf = (x: number): Column => {
    let found = metrics.columns[0];
    for (const column of metrics.columns) if (x >= column.left - metrics.bodySize * 0.3) found = column;
    return found;
  };

  const indentBy = metrics.bodySize * 0.6;
  const isIndented = (line: PdfLine) => line.x > columnOf(line.x).left + indentBy;

  /**
   * How far short of the right margin a line has to stop before it counts as
   * having ended a paragraph. Justified text reaches the margin on every
   * line but the last; ragged-right text falls short of it by up to a whole
   * word, which is why this is a share of the measure and not a few points.
   */
  const isShort = (right: number, column: Column) =>
    right < column.right - Math.max((column.right - column.left) * 0.15, metrics.bodySize * 2.5);

  /**
   * Whether the book marks its paragraphs at all. Most do, by indenting the
   * first line or by leaving a blank one. In a book that does neither, a
   * line stopping short is the only evidence there is — but where there is
   * better evidence, using shortness as well would break a paragraph at
   * every ragged line end.
   */
  const marked = (() => {
    let indents = 0;
    let gaps = 0;
    for (let i = 0; i < lines.length; i++) {
      if (isIndented(lines[i])) indents++;
      const previous = lines[i - 1];
      if (previous && previous.page === lines[i].page && lines[i].y - previous.y > metrics.leading * 1.45) gaps++;
    }
    return indents >= lines.length * 0.04 || gaps >= lines.length * 0.02;
  })();

  const out: LaidOutBlock[] = [];
  let open: { kind: BlockKind; text: string; page: number; right: number; column: Column } | null = null;
  const close = () => {
    if (open) {
      const text = clean(open.text);
      if (text) out.push({ block: { kind: open.kind, text }, page: open.page });
    }
    open = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const previous = lines[i - 1];
    const kind = headingKind(line, metrics, bodyFont);

    let breaks = true;
    if (open && previous && !kind && open.kind === "p") {
      const ended = isShort(open.right, open.column);
      if (line.page !== previous.page) {
        // A page turn is not a paragraph break: a book runs on across it.
        // Unless the previous page stopped short, or the new one opens on an
        // indent, either of which means a paragraph ended at the page foot.
        breaks = ended || (marked && isIndented(line));
      } else if (marked) {
        breaks = line.y - previous.y > metrics.leading * 1.45 || isIndented(line);
      } else {
        breaks = ended && ENDS_SENTENCE.test(open.text);
      }
    }

    if (breaks) {
      close();
      open = { kind: kind ?? "p", text: line.text, page: line.page, right: line.right, column: columnOf(line.x) };
    } else if (open) {
      open.text = joinWrapped(open.text, line.text);
      open.right = line.right;
    }
  }
  close();

  return { blocks: mergeHeadings(out), metrics };
}

/** A chapter title set over two lines is one heading, not two. */
function mergeHeadings(blocks: LaidOutBlock[]): LaidOutBlock[] {
  const out: LaidOutBlock[] = [];
  for (const entry of blocks) {
    const previous = out[out.length - 1];
    if (
      previous &&
      previous.block.kind !== "p" &&
      previous.block.kind === entry.block.kind &&
      previous.page === entry.page &&
      // "CHAPTER ONE" over "The Boy Who Lived" is one title. Two numbered
      // headings in a row are two chapters.
      !isChapterHeading(entry.block.text) &&
      previous.block.text.length + entry.block.text.length <= 90
    ) {
      // "CHAPTER ONE" over "The Boy Who Lived" is a label and its subtitle,
      // and gets a colon. "OPTIONS, FUTURES," over "AND OTHER DERIVATIVES"
      // is one phrase broken across two lines, and gets a space — which the
      // comma it breaks at is what says so.
      const label =
        !/[,;]$/.test(previous.block.text) &&
        (isChapterHeading(previous.block.text) || isAllCaps(previous.block.text));
      previous.block = {
        kind: previous.block.kind,
        text: `${bareHeading(previous.block.text)}${label ? ": " : " "}${entry.block.text}`,
      };
      continue;
    }
    out.push({ page: entry.page, block: { ...entry.block } });
  }
  return out;
}
