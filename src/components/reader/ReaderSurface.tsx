"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { HighlightStyle } from "@/lib/storage/prefs";
import { wordAtCharIndex, type SegmentedChapter, type Sentence } from "@/lib/text/segment";
import type { Block } from "@/lib/types";
import { ArrowDownIcon } from "@/components/ui/Icons";
import { charOffsetAtPoint, mergeLineRects, type Rect } from "./geometry";
import { HighlightLayer } from "./HighlightLayer";
import styles from "./Reader.module.css";

interface Props {
  chapter: SegmentedChapter;
  currentSentence: number;
  currentWord: number;
  highlight: HighlightStyle;
  /** Auto-scroll only follows along while the voice is actually reading. */
  following: boolean;
  /** The way back has to clear the dock, which is two different heights. */
  controlsExpanded: boolean;
  /** A walkthrough sign owns the same corner of the screen, and is a moment.
   *  The way back waits for it. */
  hintShowing: boolean;
  onWordTap: (sentenceIndex: number, wordIndex: number) => void;
  onSentenceHold: (sentenceIndex: number) => void;
  bookmarkedSentences: Set<number>;
}

/** How long the reader's own scrolling wins over auto-scroll. */
const YIELD_MS = 10000;
/** How far the current sentence must sit outside the viewport before the way
 *  back is offered. A line half off the edge is still being read. */
const AWAY_SLACK_PX = 40;
/** The dock is opaque over the foot of the page, so a line behind it is as
 *  lost as one below the fold. Two heights, matching the two dock states. */
const DOCK_COVER_PX = { bar: 170, capsule: 100 } as const;
const HOLD_MS = 480;
const HOLD_SLOP_PX = 10;

function tagFor(kind: Block["kind"]): "h1" | "h2" | "h3" | "blockquote" | "p" {
  if (kind === "h1" || kind === "h2" || kind === "h3") return kind;
  if (kind === "quote") return "blockquote";
  return "p";
}

/** The current sentence is the only one rendered word by word: it keeps the
 *  DOM small on long chapters while still giving exact word rectangles. */
function SentenceWords({ sentence }: { sentence: Sentence }) {
  const { text, lead, words } = sentence;
  const parts: React.ReactNode[] = [];
  let cursor = 0;

  if (lead > 0) parts.push(text.slice(0, lead));
  words.forEach((word, index) => {
    if (word.start > cursor) parts.push(text.slice(lead + cursor, lead + word.start));
    parts.push(
      <span key={index} data-w={index} className={styles.word}>
        {text.slice(lead + word.start, lead + word.end)}
      </span>,
    );
    cursor = word.end;
  });
  parts.push(text.slice(lead + cursor));

  return (
    <span data-s={sentence.index} className={`${styles.sentence} ${styles.currentSentence}`}>
      {parts}
    </span>
  );
}

interface BlockProps {
  block: Block;
  sentences: Sentence[];
  activeSentence: number | null;
  bookmarked: boolean;
}

const BlockView = memo(function BlockView({
  block,
  sentences,
  activeSentence,
  bookmarked,
}: BlockProps) {
  const Tag = tagFor(block.kind);
  return (
    <Tag
      className={styles[block.kind === "quote" ? "quote" : block.kind]}
      data-current={activeSentence !== null ? "true" : undefined}
      data-bookmarked={bookmarked ? "true" : undefined}
    >
      {sentences.map((sentence) =>
        sentence.index === activeSentence ? (
          <SentenceWords key={sentence.index} sentence={sentence} />
        ) : (
          <span key={sentence.index} data-s={sentence.index} className={styles.sentence}>
            {sentence.text}
          </span>
        ),
      )}
    </Tag>
  );
});

export function ReaderSurface({
  chapter,
  currentSentence,
  currentWord,
  highlight,
  following,
  controlsExpanded,
  hintShowing,
  onWordTap,
  onSentenceHold,
  bookmarkedSentences,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [sentenceRects, setSentenceRects] = useState<Rect[]>([]);
  const [wordRect, setWordRect] = useState<Rect | null>(null);
  const [away, setAway] = useState<"up" | "down" | null>(null);
  const activeWordEl = useRef<HTMLElement | null>(null);
  const yieldUntil = useRef(0);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdOrigin = useRef<{ x: number; y: number } | null>(null);
  const holdFired = useRef(false);

  const measure = useCallback(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const sentenceEl = surface.querySelector<HTMLElement>(`[data-s="${currentSentence}"]`);
    if (!sentenceEl) {
      setSentenceRects([]);
      setWordRect(null);
      return;
    }
    const origin = surface.getBoundingClientRect();

    const range = document.createRange();
    range.selectNodeContents(sentenceEl);
    setSentenceRects(mergeLineRects(range.getClientRects(), origin));

    const wordEl = sentenceEl.querySelector<HTMLElement>(`[data-w="${currentWord}"]`);
    if (!wordEl) {
      setWordRect(null);
      return;
    }
    const rect = wordEl.getBoundingClientRect();
    setWordRect({
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      w: rect.width,
      h: rect.height,
    });
  }, [currentSentence, currentWord]);

  useLayoutEffect(measure, [measure]);

  // Re-measure when the column reflows: rotation, window resize, type changes.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(surface);
    // Web fonts landing after first paint shift every rectangle.
    document.fonts?.ready.then(() => measure()).catch(() => {});
    return () => observer.disconnect();
  }, [measure]);

  // The spoken word is marked imperatively so that moving through a sentence
  // never re-renders the chapter.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    activeWordEl.current?.removeAttribute("data-speaking");
    const next = surface.querySelector<HTMLElement>(
      `[data-s="${currentSentence}"] [data-w="${currentWord}"]`,
    );
    if (next) next.setAttribute("data-speaking", "true");
    activeWordEl.current = next;
  }, [currentSentence, currentWord]);

  // Any deliberate scroll hands control back to the reader for a while.
  useEffect(() => {
    const yieldNow = () => {
      yieldUntil.current = Date.now() + YIELD_MS;
    };
    const options = { passive: true } as const;
    window.addEventListener("wheel", yieldNow, options);
    window.addEventListener("touchmove", yieldNow, options);
    return () => {
      window.removeEventListener("wheel", yieldNow);
      window.removeEventListener("touchmove", yieldNow);
    };
  }, []);

  const scrollToCurrent = useCallback(() => {
    const surface = surfaceRef.current;
    const sentenceEl = surface?.querySelector<HTMLElement>(`[data-s="${currentSentence}"]`);
    if (!sentenceEl) return false;

    const rect = sentenceEl.getBoundingClientRect();
    const target = window.scrollY + rect.top - window.innerHeight * 0.32;
    if (Math.abs(target - window.scrollY) < 28) return false;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: Math.max(0, target), behavior: reduced ? "auto" : "smooth" });
    return true;
  }, [currentSentence]);

  // Keep the current sentence in the upper-middle of the viewport.
  useEffect(() => {
    if (!following) return;
    if (Date.now() < yieldUntil.current) return;
    scrollToCurrent();
  }, [currentSentence, following, scrollToCurrent]);

  // Reading ahead or back is normal, and losing the voice is the cost of it.
  // While the spoken line is off screen there is one way back to it.
  useEffect(() => {
    if (!following || hintShowing) {
      setAway(null);
      return;
    }
    let frame = 0;
    const look = () => {
      frame = 0;
      const el = surfaceRef.current?.querySelector<HTMLElement>(`[data-s="${currentSentence}"]`);
      if (!el) return setAway(null);
      const rect = el.getBoundingClientRect();
      const floor =
        window.innerHeight - (controlsExpanded ? DOCK_COVER_PX.bar : DOCK_COVER_PX.capsule);
      if (rect.bottom < AWAY_SLACK_PX) return setAway("up");
      if (rect.top > floor - AWAY_SLACK_PX) return setAway("down");
      setAway(null);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(look);
    };
    look();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [currentSentence, following, controlsExpanded, hintShowing]);

  const onBackToReading = useCallback(() => {
    yieldUntil.current = 0; // the reader asked for the voice back; stop yielding to the scroll
    scrollToCurrent(); // the pill clears itself as the line arrives, not before
  }, [scrollToCurrent]);

  const resolveTap = useCallback(
    (target: EventTarget | null, clientX: number, clientY: number) => {
      const element = target instanceof Element ? target.closest<HTMLElement>("[data-s]") : null;
      if (!element) return null;
      const sentenceIndex = Number(element.dataset.s);
      const sentence = chapter.sentences[sentenceIndex];
      if (!sentence) return null;

      const offset = charOffsetAtPoint(element, clientX, clientY);
      if (offset === null) return { sentenceIndex, wordIndex: 0 };
      return {
        sentenceIndex,
        wordIndex: wordAtCharIndex(sentence.words, Math.max(0, offset - sentence.lead)),
      };
    },
    [chapter],
  );

  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdOrigin.current = null;
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      holdFired.current = false;
      const element =
        event.target instanceof Element ? event.target.closest<HTMLElement>("[data-s]") : null;
      if (!element) return;
      const sentenceIndex = Number(element.dataset.s);
      holdOrigin.current = { x: event.clientX, y: event.clientY };
      holdTimer.current = setTimeout(() => {
        holdFired.current = true;
        cancelHold();
        onSentenceHold(sentenceIndex);
      }, HOLD_MS);
    },
    [cancelHold, onSentenceHold],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const origin = holdOrigin.current;
      if (!origin) return;
      if (
        Math.abs(event.clientX - origin.x) > HOLD_SLOP_PX ||
        Math.abs(event.clientY - origin.y) > HOLD_SLOP_PX
      ) {
        cancelHold();
      }
    },
    [cancelHold],
  );

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      cancelHold();
      if (holdFired.current) {
        holdFired.current = false;
        return;
      }
      const hit = resolveTap(event.target, event.clientX, event.clientY);
      if (hit) onWordTap(hit.sentenceIndex, hit.wordIndex);
    },
    [cancelHold, onWordTap, resolveTap],
  );

  const currentBlock = chapter.sentences[currentSentence]?.blockIndex ?? -1;

  return (
    <div className={styles.surface} ref={surfaceRef}>
      <HighlightLayer
        sentenceRects={sentenceRects}
        sentenceKey={String(currentSentence)}
        wordRect={wordRect}
        wordKey={`${currentSentence}:${currentWord}`}
        style={highlight}
      />
      <div
        className={styles.flow}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onClick={onClick}
      >
        {chapter.blocks.map((block, blockIndex) => {
          const indices = chapter.blockSentences[blockIndex] ?? [];
          return (
            <BlockView
              key={blockIndex}
              block={block}
              sentences={indices.map((index) => chapter.sentences[index])}
              activeSentence={blockIndex === currentBlock ? currentSentence : null}
              bookmarked={indices.some((index) => bookmarkedSentences.has(index))}
            />
          );
        })}
      </div>

      {/* Portalled out of the surface, which isolates its own stacking
          context: a z-index inside it can never clear the control dock. */}
      {away &&
        createPortal(
          <button
            type="button"
            className={styles.backToReading}
            data-at={away}
            data-clear={controlsExpanded ? "bar" : "capsule"}
            onClick={onBackToReading}
          >
            <ArrowDownIcon size={15} className={styles.backArrow} />
            Back to reading
          </button>,
          document.body,
        )}
    </div>
  );
}
