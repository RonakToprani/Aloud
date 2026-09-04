"use client";

import { useEffect } from "react";

export interface MediaSessionConfig {
  /** The book, not the sentence — this is what the lock screen shows. */
  title: string;
  artist: string;
  /** Chapter, shown as the secondary line. */
  album: string;
  /** Object URL for the book's own cover, when it has one. */
  artwork?: string | null;
  playing: boolean;
  /** Whole-book length in seconds, so the scrubber reads like an audiobook
   *  rather than counting out the sentence currently being spoken. */
  durationSeconds?: number;
  positionSeconds?: number;
  playbackRate?: number;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrevious: () => void;
}

function hasMediaSession(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

/** Lock-screen and Bluetooth transport controls. Silently does nothing on
 *  browsers without the API. */
export function useMediaSession(config: MediaSessionConfig | null): void {
  const title = config?.title;
  const artist = config?.artist;
  const album = config?.album;
  const artwork = config?.artwork ?? null;
  const playing = config?.playing ?? false;
  const durationSeconds = config?.durationSeconds;
  const positionSeconds = config?.positionSeconds;
  const playbackRate = config?.playbackRate ?? 1;
  const onPlay = config?.onPlay;
  const onPause = config?.onPause;
  const onNext = config?.onNext;
  const onPrevious = config?.onPrevious;

  useEffect(() => {
    if (!hasMediaSession()) return;
    const session = navigator.mediaSession;
    if (!title) {
      session.metadata = null;
      return;
    }
    try {
      // The book's own cover is what makes the notification look like
      // something rather than like a web page; the app icon is the fallback.
      const art = artwork
        ? [{ src: artwork, sizes: "512x512", type: "image/png" }]
        : [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          ];
      session.metadata = new MediaMetadata({
        title,
        artist: artist ?? "",
        album: album ?? "",
        artwork: art,
      });
    } catch {
      /* metadata is a nicety; the handlers below are the useful part */
    }
  }, [title, artist, album, artwork]);

  useEffect(() => {
    if (!hasMediaSession()) return;
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
    if (!hasMediaSession()) return;
    try {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    } catch {
      /* ignore */
    }
  }, [playing]);

  useEffect(() => {
    if (!hasMediaSession() || !navigator.mediaSession.setPositionState) return;
    if (
      typeof durationSeconds !== "number" ||
      typeof positionSeconds !== "number" ||
      !Number.isFinite(durationSeconds) ||
      !Number.isFinite(positionSeconds) ||
      durationSeconds <= 0
    ) {
      return;
    }
    try {
      // The spec rejects a position beyond the duration, and a rate of zero.
      navigator.mediaSession.setPositionState({
        duration: durationSeconds,
        position: Math.min(Math.max(0, positionSeconds), durationSeconds),
        playbackRate: playbackRate > 0 ? playbackRate : 1,
      });
    } catch {
      /* a browser that dislikes these numbers simply shows no scrubber */
    }
  }, [durationSeconds, positionSeconds, playbackRate]);
}
