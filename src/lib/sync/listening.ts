"use client";

import { useEffect, useRef } from "react";
import { supabaseConfigured } from "@/lib/supabase/client";
import { setListening } from "./presence";
import { pushListening, pushListeningNow, type ListeningSession } from "./remote";

/** How often a playing session writes its running total. */
const FLUSH_MS = 15_000;
const LOCAL_KEY = "aloud.listened.v1";

function makeId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Seconds this device has listened, ever, for the account sheet. */
export function localListenedSeconds(): number {
  try {
    return Number(localStorage.getItem(LOCAL_KEY)) || 0;
  } catch {
    return 0;
  }
}

function addLocal(seconds: number): void {
  try {
    localStorage.setItem(LOCAL_KEY, String(localListenedSeconds() + seconds));
  } catch {
    /* ignore */
  }
}

/**
 * Counts the seconds a reader actually spends listening and reports them.
 * Time is measured against the clock while `playing` is true, written every
 * few seconds while playing, on pause, and — with a keepalive request — as
 * the page closes, so a crash costs seconds rather than minutes. One session
 * row per reader visit; the row's total is replaced, never summed twice.
 */
export function useListeningClock(playing: boolean, bookId: string | null, userId: string | null): void {
  const session = useRef<ListeningSession>({ id: makeId(), bookId, seconds: 0, startedAt: Date.now() });
  const since = useRef<number | null>(null);
  const flushedAt = useRef(0);
  const uid = useRef(userId);
  uid.current = userId;
  session.current.bookId = bookId;

  useEffect(() => {
    const accumulate = () => {
      if (since.current === null) return;
      const now = Date.now();
      const delta = (now - since.current) / 1000;
      since.current = now;
      session.current.seconds += delta;
      addLocal(delta);
    };

    const flush = (closing: boolean) => {
      accumulate();
      const current = session.current;
      if (Math.floor(current.seconds) <= flushedAt.current) return;
      flushedAt.current = Math.floor(current.seconds);
      if (!supabaseConfigured) return;
      if (closing) pushListeningNow({ ...current }, uid.current);
      else void pushListening({ ...current }).catch(() => {});
    };

    if (playing) {
      since.current = Date.now();
      if (supabaseConfigured) setListening(true);
      const timer = setInterval(() => flush(false), FLUSH_MS);
      const onHide = () => {
        if (document.visibilityState === "hidden") flush(true);
      };
      const onPageHide = () => flush(true);
      document.addEventListener("visibilitychange", onHide);
      window.addEventListener("pagehide", onPageHide);
      return () => {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onHide);
        window.removeEventListener("pagehide", onPageHide);
        flush(false);
        since.current = null;
        if (supabaseConfigured) setListening(false);
      };
    }
    return undefined;
  }, [playing]);
}
