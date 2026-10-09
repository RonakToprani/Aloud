"use client";

import { useEffect, useState } from "react";
import { defaultOfflineVoiceId, getOfflineSources, offlineSourceFor } from "@/lib/speech/offline/registry";
import type { OfflineVoiceState } from "@/lib/speech/offline/source";

const EMPTY: OfflineVoiceState = {
  status: "idle",
  progress: 0,
  downloadBytes: 0,
  backend: null,
  pending: 0,
  downloaded: false,
  error: null,
  preparing: null,
  events: [],
};

/** The state of the offline model behind `voiceId`, or of the default
 *  offline model when the voice is not an offline one: whether it is
 *  downloaded, how far along a download is, and whether the reader is
 *  waiting on it right now. */
export function useOfflineVoice(voiceId: string | null | undefined): OfflineVoiceState {
  const source = typeof window === "undefined" ? null : offlineSourceFor(voiceId) ?? offlineSourceFor(defaultOfflineVoiceId());
  const [state, setState] = useState<OfflineVoiceState>(() => source?.current ?? EMPTY);
  useEffect(() => {
    if (!source) return;
    setState(source.current);
    return source.subscribe(setState);
  }, [source]);
  return source ? state : EMPTY;
}

/** True when any offline model on this page can run. */
export function offlineVoicesAvailable(): boolean {
  return typeof window !== "undefined" && getOfflineSources().some((source) => source.supported());
}

export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}
