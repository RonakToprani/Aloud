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
const BLOCK_SELECTOR = "p,h1,h2,h3,h4,h5,h6,blockquote,li,dd,dt,figcaption,pre";

function clean(text: string): string {
  return text.replace(/ /g, " ").replace(/\s+/g, " ").trim();
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
function extractBlocks(root: Element): Block[] {
  const out: Block[] = [];

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
        if (element.querySelector(BLOCK_SELECTOR)) {
          walk(element);
        } else {
          const text = clean(element.textContent ?? "");
          if (text) out.push({ kind: kindOf(tag), text });
        }
        continue;
      }

      // Anything else is inline as far as reading is concerned.
      pending += element.textContent ?? "";
    }
    flush();
  };

  walk(root);
  return out;
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
  for (const part of decodeURIComponent(href).split("/")) {
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
function buildTocTitles(doc: Document, basePath: string): Map<string, string> {
  const titles = new Map<string, string>();

  for (const point of named(doc, "navPoint")) {
    const label = firstNamed(point, "text");
    const content = firstNamed(point, "content");
    const src = content?.getAttribute("src");
    const text = clean(label?.textContent ?? "");
    if (src && text) titles.set(resolvePath(basePath, src), text);
  }

  if (!titles.size) {
    for (const anchor of Array.from(doc.querySelectorAll("nav a, a"))) {
      const href = anchor.getAttribute("href");
      const text = clean(anchor.textContent ?? "");
      if (href && text) titles.set(resolvePath(basePath, href), text);
    }
  }
  return titles;
}

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
      "This file isn't a readable EPUB — it may be damaged or only renamed to .epub.",
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
  let titles = new Map<string, string>();
  for (const source of [navItem, ncxItem]) {
    if (!source || titles.size) continue;
    const file = zip.file(source.path);
    if (!file) continue;
    try {
      titles = buildTocTitles(parseXml(await file.async("text")), source.path);
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

  for (let i = 0; i < spineIds.length; i++) {
    const entry = manifest.get(spineIds[i]);
    onProgress?.(spineIds.length ? i / spineIds.length : 1);
    if (!entry || skipPaths.has(entry.path)) continue;
    if (!/xhtml|html|xml/.test(entry.type) && !/\.x?html?$/i.test(entry.path)) continue;

    const file = zip.file(entry.path);
    if (!file) continue;

    let blocks: Block[];
    try {
      const doc = parseXml(await file.async("text"), "application/xhtml+xml");
      const body = doc.body ?? doc.documentElement;
      if (!body) continue;
      blocks = extractBlocks(body);
    } catch {
      continue;
    }
    if (!blocks.length) continue;

    const words = wordCount(blocks);
    const looksLikeCover =
      /cover|title-?page|halftitle/i.test(entry.path) && words < 25;
    if (looksLikeCover || words < 3) continue;

    // A leading heading becomes the chapter title rather than body text.
    const tocTitle = titles.get(entry.path);
    const leadHeading = blocks[0].kind !== "p" ? blocks[0].text : null;
    const chapterTitle = tocTitle ?? leadHeading ?? `Chapter ${chapters.length + 1}`;
    if (!tocTitle && leadHeading) blocks = blocks.slice(1);

    chapters.push({
      id: entry.path,
      title: chapterTitle,
      blocks: [{ kind: "h1", text: chapterTitle }, ...blocks],
    });

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
