"use client";

import { useEffect, useRef } from "react";

type WakeLockSentinelLike = { release: () => Promise<void>; released: boolean };
type WakeLockLike = { request: (type: "screen") => Promise<WakeLockSentinelLike> };

/** Holds the screen awake while reading, and takes the lock back after the
 *  phone has been locked and woken again. */
export function useWakeLock(active: boolean): void {
  const sentinel = useRef<WakeLockSentinelLike | null>(null);

  useEffect(() => {
    const wakeLock = (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock;
    if (!wakeLock) return;
    let cancelled = false;

    const acquire = async () => {
      if (!active || cancelled || sentinel.current) return;
      try {
        sentinel.current = await wakeLock.request("screen");
      } catch {
        // Denied while the page is hidden, or unsupported. Reading continues.
      }
    };

    const release = () => {
      const current = sentinel.current;
      sentinel.current = null;
      current?.release().catch(() => {});
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    if (active) void acquire();
    else release();

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    };
  }, [active]);
}
