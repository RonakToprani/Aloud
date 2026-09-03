import { DOMParser } from "linkedom";
import "./setup";

/** linkedom gives the EPUB parser a real enough DOM to run under Node. */
class ShimParser {
  parseFromString(source: string, mime: string) {
    const type = mime.includes("html") && !mime.includes("xhtml") ? "text/html" : "text/xml";
    const doc = new DOMParser().parseFromString(source, type as "text/html");
    if (!doc.body && doc.documentElement) {
      Object.defineProperty(doc, "body", {
        configurable: true,
        get: () => doc.querySelector("body") ?? doc.documentElement,
      });
    }
    return doc;
  }
}

(globalThis as Record<string, unknown>).DOMParser = ShimParser;
(globalThis as Record<string, unknown>).Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };
