import "./domSetup";
import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { DrmProtectedError, EpubParseError, parseEpub, parsePlainText } from "@/lib/epub/parse";

interface EpubParts {
  encryption?: string;
  rights?: boolean;
  chapters?: { href: string; body: string; id: string }[];
  extraManifest?: string;
  extraSpine?: string;
}

async function makeEpub(parts: EpubParts = {}): Promise<Uint8Array> {
  const chapters = parts.chapters ?? [
    {
      id: "c1",
      href: "ch1.xhtml",
      body: "<h1>The Window</h1><p>Mrs. Dalloway said she would buy the flowers herself.</p><p>For Lucy had her work cut out for her.</p>",
    },
    {
      id: "c2",
      href: "ch2.xhtml",
      body: "<p>The doors would be taken off their hinges; Rumpelmayer's men were coming.</p>",
    },
  ];

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  if (parts.encryption) zip.file("META-INF/encryption.xml", parts.encryption);
  if (parts.rights) zip.file("META-INF/rights.xml", "<rights/>");

  const manifest = chapters
    .map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`)
    .join("");
  const spine = chapters.map((c) => `<itemref idref="${c.id}"/>`).join("");

  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Mrs Dalloway</dc:title><dc:creator>Virginia Woolf</dc:creator></metadata><manifest>${manifest}${parts.extraManifest ?? ""}</manifest><spine>${spine}${parts.extraSpine ?? ""}</spine></package>`,
  );

  for (const c of chapters) {
    zip.file(
      `OEBPS/${c.href}`,
      `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>${c.body}</body></html>`,
    );
  }
  return zip.generateAsync({ type: "uint8array" });
}

test("reads title, author and chapters from the spine", async () => {
  const book = await parseEpub(await makeEpub());
  assert.equal(book.title, "Mrs Dalloway");
  assert.equal(book.author, "Virginia Woolf");
  assert.equal(book.chapters.length, 2);
  assert.match(book.chapters[0].blocks.map((b) => b.text).join(" "), /Mrs\. Dalloway said/);
});

test("a leading heading becomes the chapter title instead of body text", async () => {
  const book = await parseEpub(await makeEpub());
  assert.equal(book.chapters[0].title, "The Window");
  // The title is re-added once, as the opening block, so it is read aloud.
  const headings = book.chapters[0].blocks.filter((b) => b.text === "The Window");
  assert.equal(headings.length, 1);
});

test("paragraph boundaries survive parsing", async () => {
  const book = await parseEpub(await makeEpub());
  const paragraphs = book.chapters[0].blocks.filter((b) => b.kind === "p");
  assert.equal(paragraphs.length, 2);
});

test("a cover page with almost no text is skipped", async () => {
  const book = await parseEpub(
    await makeEpub({
      chapters: [
        { id: "cov", href: "cover.xhtml", body: "<p>Cover</p>" },
        { id: "c1", href: "ch1.xhtml", body: "<p>Real text begins here and carries on for a while.</p>" },
      ],
    }),
  );
  assert.equal(book.chapters.length, 1);
  assert.match(book.chapters[0].blocks[1].text, /Real text begins/);
});

test("obfuscated fonts are not mistaken for DRM", async () => {
  const encryption = `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="OEBPS/fonts/body.otf"/></CipherData></EncryptedData></encryption>`;
  const book = await parseEpub(await makeEpub({ encryption }));
  assert.equal(book.chapters.length, 2);
});

test("an encrypted chapter is reported as copy-protected", async () => {
  const encryption = `<?xml version="1.0"?><encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><CipherData><CipherReference URI="OEBPS/ch1.xhtml"/></CipherData></EncryptedData></encryption>`;
  const bytes = await makeEpub({ encryption });
  await assert.rejects(() => parseEpub(bytes), DrmProtectedError);
});

test("an Adobe rights file is reported as copy-protected", async () => {
  await assert.rejects(() => makeEpub({ rights: true }).then(parseEpub), DrmProtectedError);
});

test("a file that isn't a zip is reported plainly", async () => {
  await assert.rejects(
    () => parseEpub(new TextEncoder().encode("this is not an epub")),
    (error: unknown) => error instanceof EpubParseError && /damaged|renamed/.test((error as Error).message),
  );
});

test("an EPUB with no readable text says so", async () => {
  await assert.rejects(
    () => makeEpub({ chapters: [{ id: "c", href: "c.xhtml", body: "<p> </p>" }] }).then(parseEpub),
    (error: unknown) => error instanceof EpubParseError && /scanned|No readable/.test((error as Error).message),
  );
});

test("pasted text splits on blank lines", () => {
  const book = parsePlainText("One paragraph.\n\nAnother one.\nSame paragraph.", "Notes");
  assert.equal(book.chapters[0].blocks.length, 2);
  assert.equal(book.chapters[0].blocks[1].text, "Another one. Same paragraph.");
});
