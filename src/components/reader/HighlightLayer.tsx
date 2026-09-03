"use client";

import { useEffect, useRef, useState } from "react";
import type { HighlightStyle } from "@/lib/storage/prefs";
import { inflate, rectStyle, type Rect } from "./geometry";
import styles from "./Reader.module.css";

interface Props {
  sentenceRects: Rect[];
  /** Key identifying the sentence, so its wash refreshes rather than slides. */
  sentenceKey: string;
  wordRect: Rect | null;
  /** Key identifying the word, so the highlight knows a real move happened. */
  wordKey: string;
  style: HighlightStyle;
}

/** How long a fading-out wash lingers behind the incoming one. */
const WASH_OVERLAP_MS = 320;

/**
 * Every highlight is drawn here, behind the text, from measured rectangles.
 *
 * Pill is a single element that moves and resizes, so the eye tracks one
 * continuous object rather than a strobe of separate boxes. Wash is a pair
 * that crossfades, briefly overlapping, which reads as a voice rather than a
 * cursor. Both sit under the text and never occlude a letterform.
 */
export function HighlightLayer({ sentenceRects, sentenceKey, wordRect, wordKey, style }: Props) {
  const [washes, setWashes] = useState<{ id: number; rect: Rect }[]>([]);
  const nextId = useRef(0);
  const latestRect = useRef<Rect | null>(null);
  const previousY = useRef<number | null>(null);
  const [jumped, setJumped] = useState(true);

  latestRect.current = wordRect;

  // Pill: a change of line is a jump, not a glide. Sliding diagonally across
  // the column would pull the eye far more than the move is worth.
  useEffect(() => {
    const rect = latestRect.current;
    if (!rect) return;
    const previous = previousY.current;
    setJumped(previous === null || Math.abs(rect.y - previous) > 4);
    previousY.current = rect.y;
  }, [wordKey]);

  useEffect(() => {
    if (style !== "wash") {
      setWashes([]);
      return;
    }
    const rect = latestRect.current;
    if (!rect) return;
    const id = (nextId.current += 1);
    setWashes((current) => [...current.slice(-1), { id, rect }]);
    const timer = setTimeout(
      () => setWashes((current) => current.filter((wash) => wash.id === id)),
      WASH_OVERLAP_MS,
    );
    return () => clearTimeout(timer);
  }, [wordKey, style]);

  return (
    <div className={styles.layer} aria-hidden="true">
      {sentenceRects.map((rect, index) => (
        <div
          key={`${sentenceKey}-${index}`}
          className={styles.sentenceWash}
          style={rectStyle(inflate(rect, 2, 3))}
        />
      ))}

      {style === "pill" && wordRect && (
        <div
          className={styles.pill}
          data-jump={jumped ? "true" : "false"}
          style={rectStyle(inflate(wordRect, 4, 2))}
        />
      )}

      {style === "wash" &&
        washes.map((wash, index) => (
          <div
            key={wash.id}
            className={styles.wash}
            data-leaving={index < washes.length - 1 ? "true" : "false"}
            style={rectStyle(inflate(wash.rect, 3, 1.5))}
          />
        ))}
    </div>
  );
}
