import type * as PdfJs from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * pdf.js is a megabyte and a half and most readers never open a PDF, so it
 * is fetched the first time one is added and never before.
 *
 * The legacy build, not the modern one: it carries its own polyfills, so the
 * parser itself runs on an older phone browser and under Node in the tests.
 * The worker it starts is a module worker either way, and a browser too old
 * for those drops back to parsing in process.
 */
let loading: Promise<typeof PdfJs> | null = null;

export function loadPdfJs(): Promise<typeof PdfJs> {
  if (!loading) {
    loading = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      // Under Node there is no worker to point at, and pdf.js parses in
      // process, which is what the tests want. In a browser, parsing on the
      // main thread would freeze the page for the length of a book.
      if (typeof window !== "undefined") {
        pdfjs.GlobalWorkerOptions.workerSrc = `${assetBase(pdfjs.version)}pdf.worker.min.mjs`;
      }
      return pdfjs;
    });
    // A chunk that failed to arrive is a network away from arriving. Keeping
    // the rejected promise would make one lost connection mean no PDF ever
    // opens again on this page.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Written by scripts/pdfjs-assets.mjs, keyed by version so the service
 *  worker can cache it forever. */
const assetBase = (version: string) => `/pdfjs/${version}/`;

/** Data files pdf.js fetches on demand: the glyph outlines for the fourteen
 *  fonts a PDF may name without embedding, and the character maps a book set
 *  in Japanese or Chinese needs before its text is text at all. */
export function assetOptions(version: string): {
  cMapUrl: string;
  cMapPacked: boolean;
  standardFontDataUrl: string;
} | undefined {
  if (typeof window === "undefined") return undefined;
  const base = assetBase(version);
  return { cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/` };
}
