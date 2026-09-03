export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Range.getClientRects() returns one box per text run, so a single line can
 *  come back as several boxes. Merge everything that shares a line. */
export function mergeLineRects(rects: DOMRectList | DOMRect[], origin: DOMRect): Rect[] {
  const lines: Rect[] = [];
  for (const rect of Array.from(rects)) {
    if (rect.width <= 0 && rect.height <= 0) continue;
    const box: Rect = {
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      w: rect.width,
      h: rect.height,
    };
    const sameLine = lines.find(
      (line) => Math.abs(line.y - box.y) < Math.max(4, box.h * 0.4),
    );
    if (!sameLine) {
      lines.push(box);
      continue;
    }
    const left = Math.min(sameLine.x, box.x);
    const right = Math.max(sameLine.x + sameLine.w, box.x + box.w);
    const top = Math.min(sameLine.y, box.y);
    const bottom = Math.max(sameLine.y + sameLine.h, box.y + box.h);
    sameLine.x = left;
    sameLine.y = top;
    sameLine.w = right - left;
    sameLine.h = bottom - top;
  }
  return lines.sort((a, b) => a.y - b.y);
}

export function inflate(rect: Rect, x: number, y: number): Rect {
  return { x: rect.x - x, y: rect.y - y, w: rect.w + x * 2, h: rect.h + y * 2 };
}

export function rectStyle(rect: Rect): React.CSSProperties {
  return {
    transform: `translate3d(${rect.x}px, ${rect.y}px, 0)`,
    width: `${rect.w}px`,
    height: `${rect.h}px`,
  };
}

/** Character offset within `element` at a viewport point, across engines. */
export function charOffsetAtPoint(element: Element, x: number, y: number): number | null {
  const doc = element.ownerDocument;
  type LegacyDoc = Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  const legacy = doc as LegacyDoc;

  let node: Node | null = null;
  let offset = 0;

  if (legacy.caretRangeFromPoint) {
    const range = legacy.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  } else if (legacy.caretPositionFromPoint) {
    const position = legacy.caretPositionFromPoint(x, y);
    if (position) {
      node = position.offsetNode;
      offset = position.offset;
    }
  }
  if (!node || !element.contains(node)) return null;

  // Count the characters before the caret inside this element.
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return total + offset;
    total += current.nodeValue?.length ?? 0;
    current = walker.nextNode();
  }
  return null;
}
