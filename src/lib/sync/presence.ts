"use client";

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase/client";

/**
 * "Listening right now" is a presence channel: every open tab joins it, and
 * a tab that is actually playing marks itself so. The count is of tabs that
 * are playing, not tabs that are open — a library page left in the
 * background is not a listener.
 */

type Listener = (count: number) => void;

let channel: RealtimeChannel | null = null;
let joined = false;
let listening = false;
const listeners = new Set<Listener>();
let lastCount = 0;

function key(): string {
  try {
    const stored = sessionStorage.getItem("aloud.presence");
    if (stored) return stored;
    const fresh = crypto.randomUUID();
    sessionStorage.setItem("aloud.presence", fresh);
    return fresh;
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

function countListening(): number {
  if (!channel) return 0;
  const state = channel.presenceState<{ listening: boolean }>();
  let count = 0;
  for (const presences of Object.values(state)) {
    if (presences.some((p) => p.listening)) count += 1;
  }
  return count;
}

function broadcast(): void {
  lastCount = countListening();
  for (const listener of listeners) listener(lastCount);
}

function ensureChannel(): RealtimeChannel | null {
  if (channel) return channel;
  const supabase = getSupabase();
  if (!supabase) return null;
  channel = supabase.channel("listening", { config: { presence: { key: key() } } });
  channel
    .on("presence", { event: "sync" }, broadcast)
    .on("presence", { event: "join" }, broadcast)
    .on("presence", { event: "leave" }, broadcast)
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        joined = true;
        void channel?.track({ listening });
      }
    });
  return channel;
}

/** Tell the room whether this tab is playing. */
export function setListening(next: boolean): void {
  listening = next;
  const ch = ensureChannel();
  if (ch && joined) void ch.track({ listening });
}

/** Watch the number of tabs currently playing. */
export function subscribeListeningCount(listener: Listener): () => void {
  listeners.add(listener);
  ensureChannel();
  listener(lastCount);
  return () => {
    listeners.delete(listener);
  };
}
