/**
 * A PDF writer just large enough to test the reader against: pages of text
 * set at known coordinates, an optional outline, optional document info.
 *
 * Real PDFs are the point, not fixtures of pdf.js's output, so the tests
 * run the file through pdf.js the way a reader's browser does.
 */

export interface PdfLineSpec {
  x: number;
  /** From the bottom of the page, as PDF user space measures it. */
  y: number;
  size: number;
  text: string;
  /** Uses the second font, which is how a heading is told from body text. */
  bold?: boolean;
}

export interface PdfPageSpec {
  width?: number;
  height?: number;
  lines: PdfLineSpec[];
}

export interface PdfDocSpec {
  title?: string;
  author?: string;
  /** Outline entries, each pointing at a zero-based page. */
  outline?: { title: string; page: number }[];
}

const escape = (text: string) => text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

export function makePdf(pages: PdfPageSpec[], spec: PdfDocSpec = {}): Uint8Array {
  const objects: string[] = ["", ""]; // 1 catalog and 2 page tree, filled in last.
  const add = (body: string) => objects.push(body);

  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const regular = objects.length;
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");
  const bold = objects.length;

  const pageIds: number[] = [];
  for (const page of pages) {
    const width = page.width ?? 612;
    const height = page.height ?? 792;
    let content = "";
    for (const line of page.lines) {
      content += `BT /${line.bold ? "F2" : "F1"} ${line.size} Tf ${line.x} ${line.y} Td (${escape(line.text)}) Tj ET\n`;
    }
    add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);
    const stream = objects.length;
    add(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
        `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`,
    );
    pageIds.push(objects.length);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let outlineRef = "";
  if (spec.outline?.length) {
    const root = objects.length + 1;
    const items = spec.outline.map((_, i) => root + 1 + i);
    add(`<< /Type /Outlines /First ${items[0]} 0 R /Last ${items[items.length - 1]} 0 R /Count ${items.length} >>`);
    spec.outline.forEach((entry, i) => {
      const previous = i > 0 ? ` /Prev ${items[i - 1]} 0 R` : "";
      const next = i < items.length - 1 ? ` /Next ${items[i + 1]} 0 R` : "";
      add(
        `<< /Title (${escape(entry.title)}) /Parent ${root} 0 R${previous}${next} ` +
          `/Dest [${pageIds[entry.page]} 0 R /XYZ 0 792 0] >>`,
      );
    });
    outlineRef = ` /Outlines ${root} 0 R`;
  }

  let infoRef = "";
  if (spec.title || spec.author) {
    const title = spec.title ? `/Title (${escape(spec.title)}) ` : "";
    const author = spec.author ? `/Author (${escape(spec.author)}) ` : "";
    add(`<< ${title}${author}>>`);
    infoRef = `/Info ${objects.length} 0 R `;
  }

  objects[0] = `<< /Type /Catalog /Pages 2 0 R${outlineRef} >>`;

  const parts = ["%PDF-1.7\n"];
  const offsets: number[] = [];
  let position = parts[0].length;
  objects.forEach((body, i) => {
    offsets.push(position);
    const chunk = `${i + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(chunk);
    position += chunk.length;
  });

  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${infoRef}>>\nstartxref\n${position}\n%%EOF\n`;
  parts.push(xref);

  return new TextEncoder().encode(parts.join(""));
}

/** Wraps text to a column, the way a typesetter would, and returns the lines
 *  ready to place. Justified: every line but the last reaches the margin. */
export function wrap(
  text: string,
  options: { x: number; top: number; size: number; leading: number; columnWidth: number },
): PdfLineSpec[] {
  const perChar = options.size * 0.5;
  const perLine = Math.max(4, Math.floor(options.columnWidth / perChar));
  const words = text.split(/\s+/).filter(Boolean);

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + 1 + word.length > perLine) {
      lines.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(current);

  return lines.map((line, i) => ({ x: options.x, y: options.top - i * options.leading, size: options.size, text: line }));
}
