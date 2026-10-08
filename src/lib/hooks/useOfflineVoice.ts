"use client";

import { useEffect, useState } from "react";
import { getOfflineVoice, type OfflineVoiceState } from "@/lib/speech/kokoro/source";

/** The offline model's state, for the picker and the reader to show: whether
 *  it is downloaded, how far along a download is, and whether the reader is
 *  waiting on it right now. */
export function useOfflineVoice(): OfflineVoiceState {
  const [state, setState] = useState<OfflineVoiceState>(() =>
    typeof window === "undefined"
      ? { status: "idle", progress: 0, downloadBytes: 0, backend: null, pending: 0, downloaded: false, error: null, preparing: null }
      : getOfflineVoice().current,
  );
  useEffect(() => {
    const source = getOfflineVoice();
    setState(source.current);
    return source.subscribe(setState);
  }, []);
  return state;
}

export function formatMegabytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
}
