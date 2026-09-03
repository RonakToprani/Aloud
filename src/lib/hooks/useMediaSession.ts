"use client";

import { useEffect } from "react";

export interface MediaSessionConfig {
  title: string;
  artist: string;
  album: string;
  artwork?: string;
  playing: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

/** Lock-screen and Bluetooth transport controls. Silently does nothing on
 *  browsers without the API. */
export function useMediaSession(config: MediaSessionConfig | null): void {
  const { title, artist, album, artwork, playing } = config ?? {};
  const onPlay = config?.onPlay;
  const onPause = config?.onPause;
  const onNext = config?.onNext;
  const onPrevious = config?.onPrevious;

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    if (!config) {
      session.metadata = null;
      return;
    }
    try {
      session.metadata = new MediaMetadata({
        title: title ?? "",
        artist: artist ?? "",
        album: album ?? "",
        artwork: artwork
          ? [{ src: artwork, sizes: "512x512", type: "image/png" }]
          : [{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
      });
    } catch {
      /* metadata is a nicety; the handlers below are the useful part */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, artist, album, artwork, Boolean(config)]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    const handlers: [MediaSessionAction, (() => void) | undefined][] = [
      ["play", onPlay],
      ["pause", onPause],
      ["nexttrack", onNext],
      ["previoustrack", onPrevious],
      ["seekforward", onNext],
      ["seekbackward", onPrevious],
    ];
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler ? () => handler() : null);
      } catch {
        /* not every action is supported everywhere */
      }
    }
    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null);
        } catch {
          /* ignore */
        }
      }
    };
  }, [onPlay, onPause, onNext, onPrevious]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    } catch {
      /* ignore */
    }
  }, [playing]);
}
