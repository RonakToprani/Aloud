/**
 * PDFs in, the same chapters and blocks an EPUB produces out, so everything
 * above this file reads a PDF exactly the way it reads a book.
 *
 * The hard part is in layout.ts. This file is the pdf.js side of it: pages
 * to positioned text, the outline to chapter breaks, page one to a cover.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { ParsedBook } from "@/lib/epub/parse";
import { layoutLines, pageLines, type LaidOutBlock, type PdfLine, type PdfTextItem } from "@/lib/pdf/layout";
import { assetOptions, loadPdfJs } from "@/lib/pdf/pdfjs";
import { clean, isChapterHeading } from "@/lib/text/headings";
import type { Block, Chapter } from "@/lib/types";

export class PdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfParseError";
  }
}

export type PdfSource = ArrayBuffer | Uint8Array;

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/* ------------------------------------------------------------------- text */

/** Text runs of one page in device space, page rotation applied, so the
 *  layout code only ever sees upright text with y growing downward. */
async function readPage(page: PDFPageProxy, index: number): Promise<PdfLine[]> {
  const { Util } = await loadPdfJs();
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const items: PdfTextItem[] = [];
  for (const entry of content.items) {
    if (!("str" in entry) || !entry.str) continue;
    const t = entry.transform as number[];
    const [x0, y0] = Util.applyTransform([t[4], t[5]], viewport.transform);
    const [x1, y1] = Util.applyTransform([t[4] + entry.width, t[5]], viewport.transform);
    // A run that advances more down the page than across it is a rotated
    // watermark or a caption set sideways. Neither is part of the reading.
    if (Math.abs(y1 - y0) > Math.abs(x1 - x0)) continue;
    items.push({
      str: entry.str,
      x: Math.min(x0, x1),
      y: y0,
      width: Math.abs(x1 - x0),
      size: Math.hypot(t[2], t[3]),
      font: entry.fontName,
    });
  }

  page.cleanup();
  // Lines, not runs: a long book's text items are an order of magnitude more
  // objects than the lines they collapse into, and holding every page's
  // worth of them at once is what puts a phone out of memory.
  return pageLines({ index, width: viewport.width, height: viewport.height, items });
}

/* --------------------------------------------------------------- chapters */

/** A chapter break at a page, named by the outline entry that points there. */
interface Cut {
  page: number;
  title: string;
}

/**
 * The outline is the PDF's own table of contents, and when a book has one
 * it is far better than anything guessed from type sizes. Only one level is
 * used: the level that gives a sensible number of chapters.
 */
async function outlineCuts(doc: PDFDocumentProxy): Promise<Cut[]> {
  let outline: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>;
  try {
    outline = await doc.getOutline();
  } catch {
    return [];
  }
  if (!outline?.length) return [];

  type Entry = { depth: number; title: string; dest: unknown };
  const flat: Entry[] = [];
  const walk = (items: typeof outline, depth: number) => {
    for (const item of items ?? []) {
      flat.push({ depth, title: clean(item.title), dest: item.dest });
      if (depth < 2) walk(item.items as typeof outline, depth + 1);
    }
  };
  walk(outline, 0);

  // A book whose outline is "Part One / Part Two" over the real chapters
  // should be cut at the chapters, not at the two parts.
  const atDepth = (depth: number) => flat.filter((entry) => entry.depth === depth);
  const chosen = atDepth(0).length >= 3 ? atDepth(0) : atDepth(1).length >= 3 ? atDepth(1) : atDepth(0);

  const cuts: Cut[] = [];
  for (const entry of chosen) {
    if (!entry.title) continue;
    try {
      const dest =
        typeof entry.dest === "string" ? await doc.getDestination(entry.dest) : (entry.dest as unknown[]);
      if (!dest) continue;
      const page = await doc.getPageIndex(dest[0] as Parameters<typeof doc.getPageIndex>[0]);
      cuts.push({ page, title: entry.title });
    } catch {
      /* an outline entry pointing nowhere just costs us one chapter name */
    }
  }
  return cuts.sort((a, b) => a.page - b.page);
}

const HEADING_KINDS = /^h[12]$/;

/** Where to cut when the PDF carries no outline: its own chapter headings,
 *  or failing those, any heading at all in a document long enough to need
 *  breaking up. */
function headingCuts(blocks: LaidOutBlock[]): number[] {
  const headings = blocks
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry, index }) => index > 0 && HEADING_KINDS.test(entry.block.kind));

  // A book that opens on its first chapter heading needs only one more to be
  // a book of chapters; one that opens on a title page needs two.
  const opensOnOne =
    HEADING_KINDS.test(blocks[0]?.block.kind ?? "") && isChapterHeading(blocks[0].block.text);
  const chapterLike = headings.filter(({ entry }) => isChapterHeading(entry.block.text));
  if (chapterLike.length >= (opensOnOne ? 1 : 2)) return chapterLike.map(({ index }) => index);

  let words = 0;
  for (const { block } of blocks) words += block.text.split(/\s+/).length;
  if (words > 4000 && headings.length >= 2) return headings.map(({ index }) => index);
  return [];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function buildChapters(blocks: LaidOutBlock[], cuts: Cut[], bookTitle: string): Chapter[] {
  let bounds: number[] = [];
  let names: (string | null)[] = [];
  /** The outline's name for the text before the first cut. */
  let opening: string | null = null;

  if (cuts.length >= 2) {
    // An outline entry names a page; the chapter starts at the first block
    // set on that page. Two entries landing on one page are one chapter.
    for (const cut of cuts) {
      const index = blocks.findIndex((entry) => entry.page >= cut.page);
      if (index < 0) continue;
      // An entry pointing at the very first block names the opening chapter
      // rather than cutting a chapter off in front of it.
      if (index === 0) {
        opening = cut.title;
        continue;
      }
      // Two entries landing on one block are one chapter, and it belongs to
      // the later of them: the earlier one's pages were dropped as front
      // matter or as a contents list, so none of its text is here.
      if (bounds[bounds.length - 1] === index) names[names.length - 1] = cut.title;
      else {
        bounds.push(index);
        names.push(cut.title);
      }
    }
  } else {
    bounds = headingCuts(blocks);
    names = bounds.map(() => null);
  }

  const edges = [0, ...bounds, blocks.length];
  const chapters: Chapter[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    let part: Block[] = blocks.slice(edges[i], edges[i + 1]).map((entry) => entry.block);
    if (!part.length) continue;

    const heading = /^h[1-3]$/.test(part[0].kind) ? part[0].text : null;
    const named = i === 0 ? opening : names[i - 1];
    const title = named ?? heading ?? (i === 0 ? bookTitle : null) ?? `Chapter ${chapters.length + 1}`;

    // The reader prints the chapter title above the text, so the chapter's
    // own heading is not read as well. It is not always the first block: a
    // running head is set higher up the page than the heading is.
    const repeats = part.findIndex(
      (block, at) => at < 3 && /^h[1-3]$/.test(block.kind) && same(block.text, title),
    );
    if (repeats >= 0) part = [...part.slice(0, repeats), ...part.slice(repeats + 1)];
    if (!part.length) continue;

    chapters.push({
      id: `page-${blocks[edges[i]].page}-${edges[i]}`,
      title,
      blocks: [{ kind: "h1", text: title }, ...part],
    });
  }
  // Unless that is all there is, in which case a short book beats no book.
  const read = chapters.filter((chapter) => !isFrontMatter(chapter));
  return read.length ? read : chapters;
}

/* ------------------------------------------------------------------ title */

/** Producers put all sorts of things in the title field. */
function metadataTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = clean(raw)
    .replace(/^Microsoft Word\s*-\s*/i, "")
    .replace(/\.(pdf|docx?|rtf|tex|odt|pages)$/i, "")
    .trim();
  if (text.length < 3 || text.length > 120) return null;
  // What a producer writes when nobody gave it a title.
  if (/^(untitled|document ?\d*|presentation ?\d*|powerpoint presentation|slide ?\d*)$/i.test(text)) return null;
  // A title that is only a number, a hash or a path is the producer talking.
  if (!/\p{L}/u.test(text) || /[\\/]/.test(text)) return null;
  return text;
}

/** The largest thing set on the way in is usually the book's name. Two
 *  pages, not one: plenty of books open on a blank leaf or a plate. */
function titleFromFirstPage(blocks: LaidOutBlock[]): string | null {
  const candidates: Block[] = [];
  for (const entry of blocks) {
    if (entry.page > 1) break;
    const { kind, text } = entry.block;
    if (kind === "p" || kind === "quote") continue;
    if (text.length < 3 || text.length > 80 || isChapterHeading(text)) continue;
    candidates.push(entry.block);
  }
  // "NINTH EDITION" is set large on a title page too, but never as large as
  // the title, so the biggest wins and only then the first.
  return candidates.find((block) => block.kind === "h1")?.text ?? candidates[0]?.text ?? null;
}

/** Front matter the outline names but nobody wants read to them. An EPUB's
 *  cover page is skipped the same way, and for the same reason: a few words
 *  of jacket copy are not a chapter. */
const FRONT_MATTER = /^(cover|title|half[- ]?title|title page|copyright|copyright page|colophon)$/i;

function isFrontMatter(chapter: Chapter): boolean {
  if (!FRONT_MATTER.test(chapter.title.trim())) return false;
  let words = 0;
  for (const block of chapter.blocks) words += block.text.split(/\s+/).length;
  return words < 60;
}

/* ------------------------------------------------------------------ cover */

/** Page one, drawn. A PDF has no cover of its own, but its first page is
 *  almost always the jacket or the title page, which is close enough that
 *  the shelf looks like a shelf. */
async function renderCover(page: PDFPageProxy): Promise<Blob | undefined> {
  if (typeof document === "undefined") return undefined;
  try {
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, 640 / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext("2d");
    if (!context) return undefined;
    // PDF pages are transparent where nothing is drawn, and a transparent
    // cover on a dark theme is an unreadable smear of dark grey text.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return await new Promise<Blob | undefined>((resolve) =>
      canvas.toBlob((blob) => resolve(blob ?? undefined), "image/jpeg", 0.82),
    );
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------- main */

export async function parsePdf(
  source: PdfSource,
  fallbackTitle: string,
  onProgress?: (fraction: number) => void,
): Promise<ParsedBook> {
  const pdfjs = await loadPdfJs();

  let doc: PDFDocumentProxy;
  try {
    doc = await pdfjs.getDocument({
      // pdf.js takes ownership of the buffer it is handed, and the caller
      // may still want the file.
      data: source instanceof Uint8Array ? source.slice() : new Uint8Array(source.slice(0)),
      isEvalSupported: false,
      useSystemFonts: false,
      ...assetOptions(pdfjs.version),
    }).promise;
  } catch (error) {
    throw describe(error);
  }

  try {
    return await read(doc, fallbackTitle, onProgress);
  } catch (error) {
    // A file that opens can still be broken further in: a page whose object
    // is missing, a font that will not load. Whatever pdf.js says about it,
    // the reader sees a sentence rather than "Bad (uncompressed) XRef entry".
    throw describe(error);
  } finally {
    await doc.destroy().catch(() => {});
  }
}

async function read(
  doc: PDFDocumentProxy,
  fallbackTitle: string,
  onProgress?: (fraction: number) => void,
): Promise<ParsedBook> {
  const pages: PdfLine[][] = [];
  for (let i = 0; i < doc.numPages; i++) {
    const page = await doc.getPage(i + 1);
    pages.push(await readPage(page, i));
    onProgress?.((i + 1) / doc.numPages);
    if (i % 8 === 7) await yieldToUi();
  }

  const { blocks } = layoutLines(pages);
  if (!blocks.length) {
    throw new PdfParseError(
      "No readable text was found in this PDF. It's most likely a scan: pictures of pages rather than text, which nothing can read aloud until it has been through a text recogniser.",
    );
  }

  const info = (await doc.getMetadata().catch(() => null))?.info as Record<string, unknown> | undefined;
  const title = metadataTitle(info?.Title) ?? titleFromFirstPage(blocks) ?? fallbackTitle;
  const authorRaw = typeof info?.Author === "string" ? clean(info.Author) : "";
  const author = authorRaw && authorRaw.length <= 120 && /\p{L}/u.test(authorRaw) ? authorRaw : null;

  const chapters = buildChapters(blocks, await outlineCuts(doc), title);
  // Last, not first: a book with no text to read gets no cover drawn for it.
  const cover = await renderCover(await doc.getPage(1));
  onProgress?.(1);
  return { title, author, chapters, cover };
}

function describe(error: unknown): Error {
  const name = (error as { name?: string })?.name;
  if (name === "PasswordException") {
    return new PdfParseError(
      "This PDF is locked with a password, so its text can't be opened. A copy without the password will work.",
    );
  }
  if (name === "InvalidPDFException") {
    return new PdfParseError("This file isn't a readable PDF. It may be damaged, or only renamed to .pdf.");
  }
  if (error instanceof PdfParseError) return error;
  return new PdfParseError(
    "Something in this PDF stopped it being read. Try another copy of the book.",
  );
}
