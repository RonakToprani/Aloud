import JSZip from "jszip";
import type { Block, BlockKind, Chapter } from "@/lib/types";

export class DrmProtectedError extends Error {
  constructor() {
    super(
      "This file is copy-protected (DRM), so its text can't be opened by anything except the shop's own app.",
    );
    this.name = "DrmProtectedError";
  }
}

export class EpubParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EpubParseError";
  }
}

export interface ParsedBook {
  title: string;
  author: string | null;
  chapters: Chapter[];
  cover?: Blob;
}

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "LI", "DD", "DT", "FIGCAPTION", "PRE",
]);
const CONTAINER_TAGS = new Set([
  "DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "DL", "BLOCKQUOTE", "ASIDE", "FIGURE", "BODY",
]);
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NAV", "SVG", "IMG", "IMAGE", "AUDIO", "VIDEO", "HEAD", "LINK", "META", "RT", "RP",
]);
/** Elements that separate text without being paragraphs of their own. */
const FLOW_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "HR", "CAPTION"]);
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,blockquote,li,dd,dt,figcaption,pre";

/** Invisible characters that would otherwise land inside words. */
const INVISIBLE = /[\u00AD\u200B\u200C\u200D\uFEFF]/g;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function clean(text: string): string {
  return text.replace(INVISIBLE, "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

/** Text of an element with a space at every block or line boundary, so
 *  nested divs, table cells and <br> runs don't glue words together, and
 *  with ruby readings, scripts and styles left out. */
function flatText(element: Element): string {
  let out = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "BR") {
      out += " ";
      return;
    }
    const breaks = BLOCK_TAGS.has(tag) || CONTAINER_TAGS.has(tag) || FLOW_TAGS.has(tag);
    if (breaks) out += " ";
    for (const child of Array.from(node.childNodes)) visit(child);
    if (breaks) out += " ";
  };
  visit(element);
  return out;
}

function kindOf(tag: string): BlockKind {
  switch (tag) {
    case "H1":
      return "h1";
    case "H2":
      return "h2";
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return "h3";
    case "BLOCKQUOTE":
      return "quote";
    default:
      return "p";
  }
}

/** Walk the document in order, flushing loose inline text into paragraphs so
 *  nothing readable is dropped and nothing is emitted twice. */
/**
 * Chapter openings in converted books are rarely real headings: a bold or
 * centred paragraph reading "CHAPTER SEVEN", a lone roman numeral, a line in
 * capitals. A short paragraph that looks like one is treated as one, which
 * is what lets a single-file book be split into chapters at all.
 */
const CHAPTER_WORD =
  /^(chapter|part|book|prologue|epilogue|interlude|intermission|act|scene|canto|letter|section)\b/i;
const ROMAN = /^[IVXLCDM]{1,8}$/;
const HEADING_CLASS = /chap|title|head|ttl|heading/i;

function looksLikeHeading(text: string, element: Element): boolean {
  if (text.length > 60) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  const bare = text.replace(/[.:\-–—]+$/, "").trim();
  if (CHAPTER_WORD.test(bare)) return true;
  if (ROMAN.test(bare) || /^\d{1,3}$/.test(bare)) return true;
  // Anything below needs a line that does not read as a sentence.
  if (/[.!?,;]$/.test(text)) return false;
  const letters = bare.replace(/[^\p{L}]/gu, "");
  if (letters.length >= 3 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return true;
  const className = element.getAttribute("class") ?? "";
  if (HEADING_CLASS.test(className)) return true;
  const style = element.getAttribute("style") ?? "";
  if (/text-align:\s*center/i.test(style) && words.length <= 6) return true;
  // The whole paragraph wrapped in bold is a heading someone styled by hand.
  const only = element.children.length === 1 ? element.children[0] : null;
  if (only && /^(B|STRONG)$/i.test(only.tagName) && clean(only.textContent ?? "") === text) return true;
  return false;
}

interface Extracted {
  blocks: Block[];
  /** Element id → index of the block it begins, for anchors in a TOC. */
  anchors: Map<string, number>;
}

function extractBlocks(root: Element): Extracted {
  const out: Block[] = [];
  const anchors = new Map<string, number>();

  const note = (element: Element) => {
    const id = element.getAttribute("id") ?? element.getAttribute("name");
    if (id && !anchors.has(id)) anchors.set(id, out.length);
  };

  const walk = (node: Element): void => {
    let pending = "";
    const flush = () => {
      const text = clean(pending);
      pending = "";
      if (text) out.push({ kind: "p", text });
    };

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        pending += child.nodeValue ?? "";
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const element = child as Element;
      const tag = element.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (tag === "BR") {
        pending += " ";
        continue;
      }

      if (BLOCK_TAGS.has(tag) || CONTAINER_TAGS.has(tag)) {
        flush();
        note(element);
        if (element.querySelector(BLOCK_SELECTOR)) {
          walk(element);
        } else if (
          CONTAINER_TAGS.has(tag) &&
          Array.from(element.children).some((c) => CONTAINER_TAGS.has(c.tagName.toUpperCase()))
        ) {
          // Divs used as paragraphs, the way converters emit them: each
          // becomes its own block rather than one run of glued text.
          walk(element);
        } else {
          const text = clean(flatText(element));
          if (text) {
            const kind = kindOf(tag);
            out.push({ kind: kind === "p" && looksLikeHeading(text, element) ? "h2" : kind, text });
          }
        }
        continue;
      }
      // Inline anchors sit inside the paragraph being built.
      note(element);
      for (const inner of Array.from(element.querySelectorAll("[id],[name]"))) note(inner);
      if (FLOW_TAGS.has(tag)) {
        flush();
        const text = clean(flatText(element));
        if (text) out.push({ kind: "p", text });
        continue;
      }

      // Anything else is inline as far as reading is concerned.
      pending += flatText(element);
    }
    flush();
  };

  walk(root);
  return { blocks: out, anchors };
}

/** EPUB XML is namespaced, and prefixes vary between producers, so every
 *  lookup goes through localName rather than a qualified tag name. */
function named(root: Document | Element, localName: string): Element[] {
  return Array.from(root.querySelectorAll("*")).filter((el) => matchesName(el, localName));
}

function matchesName(el: Element, localName: string): boolean {
  if (el.localName === localName) return true;
  // Some producers, and some XML parsers, keep the prefix on localName.
  const tag = el.nodeName;
  const colon = tag.lastIndexOf(":");
  return (colon >= 0 ? tag.slice(colon + 1) : tag) === localName;
}

function firstNamed(root: Document | Element, localName: string): Element | null {
  return named(root, localName)[0] ?? null;
}

function resolvePath(base: string, relative: string): string {
  const href = relative.split("#")[0];
  if (!href) return "";
  const stack = base.split("/").slice(0, -1);
  for (const part of safeDecode(href).split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}

function parseXml(text: string, mime: DOMParserSupportedType = "application/xml"): Document {
  const doc = new DOMParser().parseFromString(text, mime);
  if (doc.querySelector("parsererror")) {
    // XHTML that fails strict parsing is common in the wild; HTML mode is far
    // more forgiving and we only want the text anyway.
    return new DOMParser().parseFromString(text, "text/html");
  }
  return doc;
}

/** Font-mangling uses encryption.xml too, so only text-bearing encrypted
 *  entries mean the book itself is locked. */
function detectDrm(encryptionXml: string, spinePaths: Set<string>): boolean {
  const doc = parseXml(encryptionXml);

  const encrypted = named(doc, "EncryptedData");
  if (!encrypted.length) return false;

  const OBFUSCATION = new Set([
    "http://www.idpf.org/2008/embedding",
    "http://ns.adobe.com/pdf/enc#RC",
  ]);

  for (const node of encrypted) {
    const algorithm = firstNamed(node, "EncryptionMethod")?.getAttribute("Algorithm") ?? "";
    if (OBFUSCATION.has(algorithm)) continue;

    const uri = decodeURIComponent(
      firstNamed(node, "CipherReference")?.getAttribute("URI") ?? "",
    );
    if (!uri) continue;
    // A genuinely encrypted spine document (or any other markup) means the
    // text itself is locked; encrypted fonts alone are just obfuscation.
    if (spinePaths.has(uri) || /\.(x?html?|xml|opf|ncx)$/i.test(uri)) return true;
    if (!/\.(ttf|otf|woff2?)$/i.test(uri)) return true;
  }
  return false;
}

/** Map spine hrefs to human titles using the EPUB 3 nav doc or EPUB 2 NCX. */
interface TocEntry {
  path: string;
  /** Anchor within the file, when the entry points inside one. */
  id: string | null;
  title: string;
}

/** The first entry per file names the file. */
function firstPerPath(entries: TocEntry[]): Map<string, string> {
  const titles = new Map<string, string>();
  for (const entry of entries) if (!titles.has(entry.path)) titles.set(entry.path, entry.title);
  return titles;
}

function splitHref(basePath: string, href: string): { path: string; id: string | null } {
  const hash = href.indexOf("#");
  const file = hash >= 0 ? href.slice(0, hash) : href;
  const id = hash >= 0 ? safeDecode(href.slice(hash + 1)) : null;
  return { path: file ? resolvePath(basePath, file) : basePath, id: id || null };
}

/** Every entry, in reading order. */
function buildTocEntries(doc: Document, basePath: string): TocEntry[] {
  const entries: TocEntry[] = [];

  for (const point of named(doc, "navPoint")) {
    const label = firstNamed(point, "text");
    const content = firstNamed(point, "content");
    const src = content?.getAttribute("src");
    const text = clean(label?.textContent ?? "");
    if (src && text) entries.push({ ...splitHref(basePath, src), title: text });
  }

  if (!entries.length) {
    // Only the table of contents: an EPUB3 nav file also carries page lists
    // and landmarks, whose anchors would turn every title into a number.
    const navs = Array.from(doc.querySelectorAll("nav"));
    const typeOf = (nav: Element) =>
      nav.getAttribute("epub:type") ?? nav.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? "";
    const toc = navs.find((nav) => /\btoc\b/i.test(typeOf(nav))) ?? navs[0];
    const anchors = toc ? Array.from(toc.querySelectorAll("a")) : Array.from(doc.querySelectorAll("a"));
    for (const anchor of anchors) {
      const href = anchor.getAttribute("href");
      const text = clean(anchor.textContent ?? "");
      if (href && text) entries.push({ ...splitHref(basePath, href), title: text });
    }
  }
  return entries;
}

/** A page that is itself a table of contents has nothing to read. */
const CONTENTS_TITLE = /^(table of )?contents$/i;

/** Titles a chapter should be split at even without a table of contents. */
function isChapterHeading(text: string): boolean {
  const bare = text.replace(/[.:\-–—]+$/, "").trim();
  return CHAPTER_WORD.test(bare) || ROMAN.test(bare) || /^\d{1,3}$/.test(bare);
}

/** Files shorter than this without a title of their own are the tail of the
 *  previous chapter, split across pages by a converter. */
const FRAGMENT_WORDS = 600;
/** A file this long is split at its headings whatever they look like. */
const SPLIT_WORDS = 4000;

function wordCount(blocks: Block[]): number {
  let count = 0;
  for (const block of blocks) count += block.text.split(/\s+/).length;
  return count;
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Accepts anything JSZip can read, which keeps the parser testable outside
 *  a browser as well as taking a File straight from the picker. */
export type EpubSource = Blob | ArrayBuffer | Uint8Array;

export async function parseEpub(
  file: EpubSource,
  onProgress?: (fraction: number) => void,
): Promise<ParsedBook> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new EpubParseError(
      "This file isn't a readable EPUB. It may be damaged, or only renamed to .epub.",
    );
  }

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) throw new EpubParseError("This EPUB is missing its container index.");

  const container = parseXml(await containerFile.async("text"));
  const rootPath = firstNamed(container, "rootfile")?.getAttribute("full-path");
  if (!rootPath) throw new EpubParseError("This EPUB doesn't say where its contents begin.");

  const opfFile = zip.file(rootPath);
  if (!opfFile) throw new EpubParseError("This EPUB's contents index is missing.");
  const opf = parseXml(await opfFile.async("text"));

  const all = Array.from(opf.querySelectorAll("*"));
  const items = all.filter((el) => el.localName === "item");
  const manifest = new Map<string, { path: string; type: string; properties: string }>();
  for (const item of items) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      path: resolvePath(rootPath, href),
      type: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") ?? "",
    });
  }

  const spineIds = all
    .filter((el) => el.localName === "itemref")
    .filter((el) => el.getAttribute("linear") !== "no")
    .map((el) => el.getAttribute("idref"))
    .filter((id): id is string => Boolean(id));

  const spinePaths = new Set(
    spineIds.map((id) => manifest.get(id)?.path).filter((p): p is string => Boolean(p)),
  );

  const encryption = zip.file("META-INF/encryption.xml");
  if (encryption && detectDrm(await encryption.async("text"), spinePaths)) {
    throw new DrmProtectedError();
  }
  if (zip.file("META-INF/rights.xml")) throw new DrmProtectedError();

  const meta = all.find((el) => el.localName === "metadata");
  const metaText = (name: string): string | null => {
    if (!meta) return null;
    const node = firstNamed(meta, name);
    const text = clean(node?.textContent ?? "");
    return text || null;
  };
  const title = metaText("title") ?? "Untitled";
  const author = metaText("creator");

  // Chapter titles from the navigation document, which is then excluded.
  const navItem = [...manifest.values()].find((item) => item.properties.includes("nav"));
  const ncxItem = [...manifest.values()].find((item) => item.type.includes("x-dtbncx"));
  let tocEntries: TocEntry[] = [];
  for (const source of [navItem, ncxItem]) {
    if (!source || tocEntries.length) continue;
    const file = zip.file(source.path);
    if (!file) continue;
    try {
      tocEntries = buildTocEntries(parseXml(await file.async("text")), source.path);
    } catch {
      /* a broken table of contents just costs us nicer chapter names */
    }
  }

  const coverPath = (() => {
    const byProperty = [...manifest.values()].find((item) =>
      item.properties.includes("cover-image"),
    );
    if (byProperty) return byProperty.path;
    const metaCover = all.find(
      (el) => el.localName === "meta" && el.getAttribute("name") === "cover",
    );
    const id = metaCover?.getAttribute("content");
    return id ? manifest.get(id)?.path : undefined;
  })();

  let cover: Blob | undefined;
  if (coverPath) {
    const file = zip.file(coverPath);
    if (file) {
      try {
        cover = await file.async("blob");
      } catch {
        /* a missing cover is cosmetic */
      }
    }
  }

  const chapters: Chapter[] = [];
  const skipPaths = new Set(
    [navItem?.path, ncxItem?.path].filter((p): p is string => Boolean(p)),
  );

  const titles = firstPerPath(tocEntries);

  for (let i = 0; i < spineIds.length; i++) {
    const entry = manifest.get(spineIds[i]);
    onProgress?.(spineIds.length ? i / spineIds.length : 1);
    if (!entry || skipPaths.has(entry.path)) continue;
    if (/^image\//i.test(entry.type)) continue;
    if (!/xhtml|html/.test(entry.type) && !/\.x?html?$/i.test(entry.path)) continue;

    const file = zip.file(entry.path);
    if (!file) continue;

    let extracted: Extracted;
    let pageTitle = "";
    try {
      const doc = parseXml(await file.async("text"), "application/xhtml+xml");
      const body = doc.body ?? doc.documentElement;
      if (!body) continue;
      extracted = extractBlocks(body);
      pageTitle = clean(doc.querySelector("title")?.textContent ?? "");
    } catch {
      continue;
    }
    const { blocks } = extracted;
    if (!blocks.length) continue;

    const words = wordCount(blocks);
    const looksLikeCover =
      /cover|title-?page|halftitle/i.test(entry.path) && words < 25;
    if (looksLikeCover || words < 3) continue;

    const tocTitle = titles.get(entry.path);
    const leadHeading = /^h[1-3]$/.test(blocks[0].kind) ? blocks[0].text : null;
    // A contents page reads as a list of chapter names; skip it.
    if (CONTENTS_TITLE.test(tocTitle ?? leadHeading ?? "") && words < 600) continue;

    // Where this file splits into chapters: anchors the table of contents
    // points at, or failing that its own chapter-like headings.
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    let points: { index: number; title: string | null }[] = tocEntries
      .filter((e) => e.path === entry.path && e.id && (extracted.anchors.get(e.id) ?? 0) > 0)
      .map((e) => ({ index: extracted.anchors.get(e.id!)!, title: e.title }))
      .filter((p, idx, all) => all.findIndex((q) => q.index === p.index) === idx)
      .sort((a, b) => a.index - b.index);
    if (!points.length) {
      const headings = blocks
        .map((block, index) => ({ block, index }))
        .filter(({ block, index }) => index > 0 && /^h[12]$/.test(block.kind));
      const chapterLike = headings.filter(({ block }) => isChapterHeading(block.text));
      const chosen = chapterLike.length ? chapterLike : words > SPLIT_WORDS ? headings : [];
      points = chosen.map(({ index }) => ({ index, title: null }));
    }

    // A small untitled file that picks up mid-sentence continues the
    // previous chapter: converters paginate, and a page is not a chapter.
    const previous = chapters[chapters.length - 1];
    if (!tocTitle && !leadHeading && !points.length && previous && words < FRAGMENT_WORDS) {
      const lastText = previous.blocks[previous.blocks.length - 1]?.text ?? "";
      const openEnded = !/[.!?…"'”’)\]]$/.test(lastText);
      const continues = /^[\p{Ll}]/u.test(blocks[0].text);
      if (openEnded || continues) {
        previous.blocks.push(...blocks);
        continue;
      }
    }

    const fallbackTitle =
      pageTitle.length >= 3 && pageTitle.length <= 80 && !same(pageTitle, title) && !/\.x?html?$/i.test(pageTitle)
        ? pageTitle
        : null;

    const bounds = [0, ...points.map((p) => p.index), blocks.length];
    for (let seg = 0; seg + 1 < bounds.length; seg++) {
      let part = blocks.slice(bounds[seg], bounds[seg + 1]);
      if (!part.length) continue;
      const heading = /^h[1-3]$/.test(part[0].kind) ? part[0].text : null;
      const named = seg === 0 ? (tocTitle ?? null) : points[seg - 1].title;
      const chapterTitle = named ?? heading ?? (seg === 0 ? fallbackTitle : null) ?? `Chapter ${chapters.length + 1}`;
      // Not read twice when the title already names it.
      if (heading && (!named || same(heading, named))) part = part.slice(1);
      chapters.push({
        id: seg === 0 ? entry.path : `${entry.path}#${bounds[seg]}`,
        title: chapterTitle,
        blocks: [{ kind: "h1", text: chapterTitle }, ...part],
      });
    }

    if (i % 12 === 11) await yieldToUi();
  }

  onProgress?.(1);
  if (!chapters.length) {
    throw new EpubParseError(
      "No readable text was found in this EPUB. It may be a scanned book made of page images rather than text.",
    );
  }

  return { title, author, chapters, cover };
}

/** Plain text and pasted text: blank lines separate paragraphs. */
export function parsePlainText(text: string, title: string): ParsedBook {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map((part) => clean(part))
    .filter(Boolean);

  if (!paragraphs.length) throw new EpubParseError("There's no text here to read.");

  return {
    title,
    author: null,
    chapters: [
      {
        id: "text",
        title,
        blocks: paragraphs.map((text) => ({ kind: "p" as const, text })),
      },
    ],
  };
}
