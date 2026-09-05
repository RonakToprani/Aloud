"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A number that counts up to its target on first arrival — over ~1.2s from
 * a little below — and afterwards follows the target directly, so live
 * increments tick rather than re-animate.
 */
export function useCountUp(target: number, durationMs = 1200): number {
  const [display, setDisplay] = useState(target);
  const started = useRef(false);
  const animating = useRef(false);

  useEffect(() => {
    if (animating.current) return;
    if (started.current || target <= 0) {
      setDisplay(target);
      return;
    }
    started.current = true;
    if (typeof window === "undefined" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(target);
      return;
    }

    animating.current = true;
    const from = Math.max(0, target - Math.max(3, Math.min(400, target * 0.04)));
    const startedAt = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + (target - from) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else animating.current = false;
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      animating.current = false;
    };
  }, [target, durationMs]);

  return display;
}
