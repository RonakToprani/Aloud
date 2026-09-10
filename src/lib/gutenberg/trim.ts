import type { ParsedBook } from "@/lib/epub/parse";
import type { Chapter } from "@/lib/types";

/**
 * A Gutenberg edition opens with a page about Project Gutenberg and closes
 * with its licence, and marks where the book itself begins and ends:
 *
 *   *** START OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***
 *   *** END OF THE PROJECT GUTENBERG EBOOK PRIDE AND PREJUDICE ***
 *
 * Both markers are needed on a redistributed copy; neither wants reading
 * aloud. Everything outside them comes off before the book is shelved. The
 * licence stays where it belongs, at gutenberg.org, and the page that
 * offered the book says so.
 */

const START = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG/i;
const END = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG/i;
/** Notes Gutenberg leaves just inside the marker, about the file rather
 *  than the book: another edition to look at, who typed it up. */
const NOTE =
  /(?:illustrated|html|audio) edition of this title|may (?:be )?viewed at|e-?book\s*\[?\s*#\s*\d+|^\s*(?:produced|transcribed|e-?text prepared) by\b|^\s*\[?transcriber/i;

function find(chapters: Chapter[], marker: RegExp): [number, number] | null {
  for (let c = 0; c < chapters.length; c++) {
    const b = chapters[c].blocks.findIndex((block) => marker.test(block.text));
    if (b !== -1) return [c, b];
  }
  return null;
}

/** A chapter left with nothing but headings is a page with nothing on it. */
function hasBody(chapter: Chapter): boolean {
  return chapter.blocks.some((block) => block.kind === "p" || block.kind === "quote");
}

export function trimGutenberg(book: ParsedBook): ParsedBook {
  let chapters = book.chapters.map((chapter) => ({ ...chapter, blocks: [...chapter.blocks] }));

  const start = find(chapters, START);
  if (start) {
    const [c, b] = start;
    chapters[c].blocks.splice(0, b + 1);
    chapters = chapters.slice(c);
    const first = chapters[0].blocks;
    while (first.length && first[0].kind === "p" && NOTE.test(first[0].text)) first.shift();
    if (!hasBody(chapters[0])) chapters.shift();
  }

  const end = find(chapters, END);
  if (end) {
    const [c, b] = end;
    chapters[c].blocks.splice(b);
    chapters = chapters.slice(0, c + 1);
    if (!hasBody(chapters[chapters.length - 1])) chapters.pop();
  }

  // Nothing survived the cut: the markers were somewhere odd. The whole
  // book is better than none of it.
  if (!chapters.length) return book;
  return { ...book, chapters };
}
