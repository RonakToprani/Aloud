"use client";

import { useEffect, useState } from "react";
import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";
import { subscribeListeningCount } from "./presence";

export interface ReadingStats {
  /** Seconds read aloud across every reader, ever. */
  totalSeconds: number;
  /** Accounts, anonymous included. */
  readers: number;
  /** Readers who listened in the last seven days. */
  activeReaders: number;
  /** Tabs playing right now. */
  listeningNow: number;
  /** True once a fresh value has arrived from the server this session. */
  fresh: boolean;
  /** True when a Supabase project is configured at all. */
  available: boolean;
}

const CACHE_KEY = "aloud.stats.v1";
const REFRESH_MS = 60_000;

function readCache(): Pick<ReadingStats, "totalSeconds" | "readers" | "activeReaders"> | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ReadingStats>;
    return {
      totalSeconds: Number(parsed.totalSeconds) || 0,
      readers: Number(parsed.readers) || 0,
      activeReaders: Number(parsed.activeReaders) || 0,
    };
  } catch {
    return null;
  }
}

function writeCache(value: Pick<ReadingStats, "totalSeconds" | "readers" | "activeReaders">): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

/**
 * The home counter. Holds the last cached value on first paint so the page
 * never looks broken, then refreshes from the pre-aggregated row and ticks
 * up live at the rate the current listeners are adding to it.
 */
export function useReadingStats(): ReadingStats {
  const [stats, setStats] = useState<ReadingStats>(() => ({
    totalSeconds: 0,
    readers: 0,
    activeReaders: 0,
    listeningNow: 0,
    fresh: false,
    available: supabaseConfigured,
  }));

  useEffect(() => {
    const cached = readCache();
    if (cached) setStats((s) => ({ ...s, ...cached }));
    if (!supabaseConfigured) return;

    let alive = true;
    const refresh = async () => {
      const supabase = getSupabase();
      if (!supabase) return;
      const { data, error } = await supabase.rpc("public_stats");
      if (!alive || error || !data) return;
      const row = data as { total_seconds: number; readers: number; active_readers: number };
      const next = {
        totalSeconds: Number(row.total_seconds) || 0,
        readers: Number(row.readers) || 0,
        activeReaders: Number(row.active_readers) || 0,
      };
      writeCache(next);
      setStats((s) => ({ ...s, ...next, fresh: true }));
    };
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    // A first visit's own account is created a moment after the page loads,
    // and it counts: read again once the session exists.
    const auth = getSupabase()?.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN") void refresh();
    });
    const unsubscribe = subscribeListeningCount((listeningNow) => {
      if (alive) setStats((s) => (s.listeningNow === listeningNow ? s : { ...s, listeningNow }));
    });
    return () => {
      alive = false;
      clearInterval(timer);
      unsubscribe();
      auth?.data.subscription.unsubscribe();
    };
  }, []);

  // Everyone listening adds a second per second. Ticking the total along
  // between refreshes is what makes the counter count rather than land.
  useEffect(() => {
    if (!stats.listeningNow) return;
    const timer = setInterval(() => {
      setStats((s) => ({ ...s, totalSeconds: s.totalSeconds + s.listeningNow }));
    }, 1000);
    return () => clearInterval(timer);
  }, [stats.listeningNow]);

  return stats;
}
