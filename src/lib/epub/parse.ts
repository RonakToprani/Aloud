import JSZip from "jszip";
import {
  bareHeading,
  CHAPTER_WORD,
  clean,
  isAllCaps,
  isChapterHeading,
  numberToWords,
  romanToInt,
  ROMAN,
  speakHeadingNumerals,
} from "@/lib/text/headings";
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
  /** Illustrations referenced by image blocks, keyed by the same zip path a
   *  block's `src` carries. Only images actually used in the text are read
   *  from the zip, and only up to IMAGE_BUDGET_BYTES. */
  images?: Record<string, Blob>;
}

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "LI", "DD", "DT", "FIGCAPTION", "PRE",
]);
const CONTAINER_TAGS = new Set([
  "DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "DL", "BLOCKQUOTE", "ASIDE", "FIGURE", "BODY",
  // Standard Ebooks puts a <header> in front of every front- and back-matter
  // page, holding a heading and, on the imprint, the logo. It has to recurse
  // like any container: otherwise the heading is never typed as one and
  // survives the "already named" dedup below to be read again after the
  // synthesised title, and the image flattens into inline text and the logo
  // is lost with no trace of having been there.
  "HEADER",
]);
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NAV", "SVG", "IMG", "IMAGE", "AUDIO", "VIDEO", "HEAD", "LINK", "META", "RT", "RP",
]);
/** Elements that separate text without being paragraphs of their own. */
const FLOW_TAGS = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "HR", "CAPTION"]);
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,blockquote,li,dd,dt,figcaption,pre";

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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

/** epub:type is a space-separated list of semantic tokens, usually prefixed
 *  ("z3998:roman"); the prefix carries no meaning we act on. */
function epubTypeTokens(el: Element): string[] {
  const raw =
    el.getAttribute("epub:type") ?? el.getAttributeNS("http://www.idpf.org/2007/ops", "type") ?? "";
  return raw
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => token.split(":").pop() ?? token);
}

function hasEpubType(el: Element, token: string): boolean {
  return epubTypeTokens(el).includes(token);
}

function romanWord(raw: string): string | null {
  const value = romanToInt(raw);
  return value === null ? null : numberToWords(value);
}

/** Like `flatText`, but also builds what should be spoken: identical except
 *  inside an element marked epub:type="z3998:roman", where a numeral kept as
 *  letters on the page ("I", "XIV") must be read as a word ("one",
 *  "fourteen") rather than spelled out or misread as the pronoun. */
function flatTextBoth(element: Element): { text: string; speakable: string } {
  let text = "";
  let speakable = "";
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.textContent ?? "";
      text += value;
      speakable += value;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "BR") {
      text += " ";
      speakable += " ";
      return;
    }
    const breaks = BLOCK_TAGS.has(tag) || CONTAINER_TAGS.has(tag) || FLOW_TAGS.has(tag);
    if (hasEpubType(el, "roman")) {
      const display = flatText(el);
      const word = romanWord(clean(display));
      if (breaks) {
        text += " ";
        speakable += " ";
      }
      text += display;
      speakable += word ?? display;
      if (breaks) {
        text += " ";
        speakable += " ";
      }
      return;
    }
    if (breaks) {
      text += " ";
      speakable += " ";
    }
    for (const child of Array.from(node.childNodes)) visit(child);
    if (breaks) {
      text += " ";
      speakable += " ";
    }
  };
  visit(element);
  return { text, speakable };
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

const HEADING_CLASS = /chap|title|head|ttl|heading/i;

/**
 * Chapter openings in converted books are rarely real headings: a bold or
 * centred paragraph reading "CHAPTER SEVEN", a lone roman numeral, a line in
 * capitals. A short paragraph that looks like one is treated as one, which
 * is what lets a single-file book be split into chapters at all.
 */
function looksLikeHeading(text: string, element: Element): boolean {
  if (text.length > 60) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  const bare = bareHeading(text);
  if (CHAPTER_WORD.test(bare)) return true;
  if (ROMAN.test(bare) || /^\d{1,3}$/.test(bare)) return true;
  // Anything below needs a line that does not read as a sentence.
  if (/[.!?,;]$/.test(text)) return false;
  if (isAllCaps(bare)) return true;
  const className = element.getAttribute("class") ?? "";
  if (HEADING_CLASS.test(className)) return true;
  const style = element.getAttribute("style") ?? "";
  if (/text-align:\s*center/i.test(style) && words.length <= 6) return true;
  // The whole paragraph wrapped in bold is a heading someone styled by hand.
  const only = element.children.length === 1 ? element.children[0] : null;
  if (only && /^(B|STRONG)$/i.test(only.tagName) && clean(only.textContent ?? "") === text) return true;
  return false;
}

/**
 * `<hgroup>` bundles a heading with one or more `<p>` lines simulating a
 * smaller one (Standard Ebooks writes a chapter opening as an ordinal `<h2>`
 * plus a title `<p>`, kept as two elements so each can carry its own size).
 * Read as one block, or the ordinal becomes a paragraph of its own and is
 * read again right after the chapter title synthesised from the ToC, which
 * names the whole thing already.
 */
function combineHgroup(hgroup: Element): Block | null {
  const parts = Array.from(hgroup.children).filter((c) => BLOCK_TAGS.has(c.tagName.toUpperCase()));
  if (!parts.length) return null;

  const pieces = parts.map((el) => {
    const both = flatTextBoth(el);
    return { text: clean(both.text), speakable: clean(both.speakable) };
  });
  const texts = pieces.map((p) => p.text).filter(Boolean);
  if (!texts.length) return null;

  // Standard Ebooks' own <head><title> joins an ordinal and the chapter name
  // with ": ", which is what lets this match the table of contents entry
  // and get deduplicated against the synthesised chapter title.
  const ordinal = hasEpubType(parts[0], "ordinal");
  const joiner = ordinal && texts.length > 1 ? ": " : " ";
  const text = texts.join(joiner);
  const speakables = pieces.map((p) => p.speakable).filter(Boolean);
  let speakable = speakables.length === texts.length ? speakables.join(joiner) : text;
  // A title line ("Part V") carries no epub:type of its own, so a numeral
  // in it never went through flatTextBoth's conversion; an hgroup is always
  // a heading, so it's safe to also convert anything that reads as a bare
  // roman numeral here, the way the h2's "I" already was.
  speakable = speakHeadingNumerals(speakable) ?? speakable;

  const outerKind = kindOf(parts[0].tagName.toUpperCase());
  const kind: BlockKind = outerKind === "p" ? "h2" : outerKind;
  return { kind, text, ...(speakable !== text ? { speakable } : {}) };
}

interface Extracted {
  blocks: Block[];
  /** Element id → index of the block it begins, for anchors in a TOC. */
  anchors: Map<string, number>;
}

/** Where an <img>, or an SVG <image>, points, before it is resolved against
 *  the chapter file's own path. SVG spells this three different ways
 *  depending on the producer and how strictly the file parsed. */
function imageHref(el: Element): string | null {
  return (
    el.getAttribute("src") ??
    el.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
    el.getAttribute("xlink:href") ??
    el.getAttribute("href")
  );
}

/** The first <img> or SVG <image> inside an element, whichever markup was used. */
function findImage(scope: Element): Element | null {
  return scope.querySelector("img, image");
}

/** Walk the document in order, flushing loose inline text into paragraphs so
 *  nothing readable is dropped and nothing is emitted twice.
 *
 *  `basePath` is the chapter file's own zip path, which is what an image's
 *  relative href is resolved against. */
function extractBlocks(root: Element, basePath: string): Extracted {
  const out: Block[] = [];
  const anchors = new Map<string, number>();

  const note = (element: Element) => {
    const id = element.getAttribute("id") ?? element.getAttribute("name");
    if (id && !anchors.has(id)) anchors.set(id, out.length);
  };

  /** `container` is the <img>, <figure> or <svg>; `imgEl` is the element that
   *  actually carries the href, which for a figure or an inline SVG is a
   *  descendant of it. */
  const pushImage = (container: Element, imgEl: Element) => {
    const href = imageHref(imgEl);
    if (!href) return;
    const src = resolvePath(basePath, href);
    if (!src) return;
    const alt = clean(imgEl.getAttribute("alt") ?? container.getAttribute("aria-label") ?? "");
    const figcaption = container.querySelector("figcaption");
    const caption = figcaption ? clean(flatText(figcaption)) : undefined;
    out.push({ kind: "image", text: "", src, alt, ...(caption ? { caption } : {}) });
  };

  const walk = (node: Element): void => {
    let pending = "";
    let pendingSpeakable = "";
    const flush = () => {
      const text = clean(pending);
      const speakable = clean(pendingSpeakable);
      pending = "";
      pendingSpeakable = "";
      if (text) out.push({ kind: "p", text, ...(speakable !== text ? { speakable } : {}) });
    };

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const value = child.nodeValue ?? "";
        pending += value;
        pendingSpeakable += value;
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;

      const element = child as Element;
      const tag = element.tagName.toUpperCase();

      // An illustration is a block of its own kind, never inline text.
      // <figure> is checked before the generic container handling below so a
      // figure that wraps an image keeps its caption attached to it, rather
      // than the caption becoming a stray paragraph next to a dropped image.
      if (tag === "FIGURE") {
        const img = findImage(element);
        if (img) {
          flush();
          note(element);
          pushImage(element, img);
          continue;
        }
        // A figure without an image (a table, say) is an ordinary container.
      } else if (tag === "IMG") {
        flush();
        note(element);
        pushImage(element, element);
        continue;
      } else if (tag === "SVG") {
        // Standard Ebooks draws its own logo as an SVG wrapping an <image>;
        // <svg> is otherwise decorative and its contents are never walked.
        const img = findImage(element);
        if (img) {
          flush();
          note(element);
          pushImage(element, img);
        }
        continue;
      }

      if (SKIP_TAGS.has(tag)) continue;
      if (tag === "BR") {
        pending += " ";
        pendingSpeakable += " ";
        continue;
      }

      if (tag === "HGROUP") {
        // Not a BLOCK_TAG or CONTAINER_TAG, so it would otherwise fall
        // through to the generic inline case below and its ordinal and
        // title lines would glue into an ordinary paragraph, never
        // recognised as the heading it is (see combineHgroup).
        flush();
        note(element);
        for (const inner of Array.from(element.querySelectorAll("[id],[name]"))) note(inner);
        const heading = combineHgroup(element);
        if (heading) out.push(heading);
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
          const both = flatTextBoth(element);
          const text = clean(both.text);
          if (text) {
            const kind = kindOf(tag);
            const finalKind = kind === "p" && looksLikeHeading(text, element) ? "h2" : kind;
            let speakable = clean(both.speakable);
            // A converted-book heading rarely carries epub:type at all, so a
            // numeral in it never met flatTextBoth's conversion; catch it
            // here once the block is known to be a heading, one way or the
            // other, rather than only when it happens to be marked up.
            if (/^h[1-3]$/.test(finalKind)) speakable = speakHeadingNumerals(speakable) ?? speakable;
            out.push({
              kind: finalKind,
              text,
              ...(speakable !== text ? { speakable } : {}),
            });
          }
        }
        continue;
      }
      // Inline anchors sit inside the paragraph being built.
      note(element);
      for (const inner of Array.from(element.querySelectorAll("[id],[name]"))) note(inner);
      if (FLOW_TAGS.has(tag)) {
        flush();
        const both = flatTextBoth(element);
        const text = clean(both.text);
        if (text) {
          const speakable = clean(both.speakable);
          out.push({ kind: "p", text, ...(speakable !== text ? { speakable } : {}) });
        }
        continue;
      }

      // Anything else is inline as far as reading is concerned.
      const inline = flatTextBoth(element);
      pending += inline.text;
      pendingSpeakable += inline.speakable;
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

/** Files shorter than this without a title of their own are the tail of the
 *  previous chapter, split across pages by a converter. */
const FRAGMENT_WORDS = 600;
/** A file this long is split at its headings whatever they look like. */
const SPLIT_WORDS = 4000;

function wordCount(blocks: Block[]): number {
  let count = 0;
  for (const block of blocks) {
    // An image has nothing to count; a caption counts like any paragraph.
    const text = block.kind === "image" ? (block.caption ?? "") : block.text;
    if (text) count += text.split(/\s+/).length;
  }
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
      extracted = extractBlocks(body, entry.path);
      pageTitle = clean(doc.querySelector("title")?.textContent ?? "");
    } catch {
      continue;
    }
    const { blocks } = extracted;
    if (!blocks.length) continue;

    const words = wordCount(blocks);
    const looksLikeCover =
      /cover|title-?page|halftitle/i.test(entry.path) && words < 25;
    // A near-wordless page is ordinarily a stub a converter left behind, but
    // a page that is nothing but a full-page illustration — a frontispiece,
    // say — is exactly the kind of page this exists to show, not drop.
    const hasImage = blocks.some((block) => block.kind === "image");
    if (looksLikeCover || (words < 3 && !hasImage)) continue;

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
      // Not read twice when the title already names it. Its speakable form
      // (a roman numeral read as a word) moves with it to the synthesised
      // title, or the fix would vanish along with the duplicate.
      let titleSpeakable: string | undefined;
      if (heading && (!named || same(heading, named))) {
        titleSpeakable = part[0].speakable;
        part = part.slice(1);
      }
      chapters.push({
        id: seg === 0 ? entry.path : `${entry.path}#${bounds[seg]}`,
        title: chapterTitle,
        blocks: [
          { kind: "h1", text: chapterTitle, ...(titleSpeakable ? { speakable: titleSpeakable } : {}) },
          ...part,
        ],
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

  const images = await readImages(zip, chapters);

  return { title, author, chapters, cover, images };
}

/** A fully illustrated novel runs to a few dozen plates at a few hundred KB
 *  each; this is generous room for that without one lavish or malicious EPUB
 *  filling a reader's device. Past the cap, later images are just left out —
 *  the book still reads fine, it only loses pictures. */
const IMAGE_BUDGET_BYTES = 40 * 1024 * 1024;

/** Reads only the images an image block actually points at, in the order
 *  they appear, stopping once the per-book budget is spent. Nothing here
 *  holds the whole zip's images in memory: each is decompressed, kept if it
 *  fits, and otherwise dropped immediately. */
async function readImages(zip: JSZip, chapters: Chapter[]): Promise<Record<string, Blob> | undefined> {
  const paths = new Set<string>();
  for (const chapter of chapters) {
    for (const block of chapter.blocks) {
      if (block.kind === "image" && block.src) paths.add(block.src);
    }
  }
  if (!paths.size) return undefined;

  const images: Record<string, Blob> = {};
  let used = 0;
  let n = 0;
  for (const path of paths) {
    const file = zip.file(path);
    if (file) {
      try {
        const blob = await file.async("blob");
        if (used + blob.size <= IMAGE_BUDGET_BYTES) {
          images[path] = blob;
          used += blob.size;
        }
      } catch {
        /* one unreadable image just means that picture is missing */
      }
    }
    n += 1;
    if (n % 8 === 0) await yieldToUi();
  }
  return Object.keys(images).length ? images : undefined;
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
