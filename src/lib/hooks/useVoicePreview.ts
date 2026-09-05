"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpeechEngine, UtteranceHandle } from "@/lib/speech/engine";

/** A voice auditions by introducing itself. Vendor suffixes like
 *  "(Enhanced)" are dropped so it says its name, not its packaging. */
export function voiceIntro(name: string): string {
  const plain = name.replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+(multilingual|neural|online|natural)$/i, "").trim() || "your reader";
  return `Hi, I'm ${plain}. I'll read your books at whatever speed you like, and light up each word as I say it. If you like how I sound, choose me and press play.`;
}

/**
 * Plays a short sample in a voice, one at a time. Tapping the voice that is
 * already playing stops it. Anything playing is stopped when the owner
 * unmounts, so a sample never outlives the sheet it started from.
 */
export function useVoicePreview(engine: SpeechEngine, rate: number) {
  const [previewing, setPreviewing] = useState<string | null>(null);
  const handle = useRef<UtteranceHandle | null>(null);

  const stop = useCallback(() => {
    handle.current?.cancel();
    handle.current = null;
    engine.cancel();
    setPreviewing(null);
  }, [engine]);

  const preview = useCallback(
    (voiceId: string, text: string) => {
      if (previewing === voiceId) {
        stop();
        return;
      }
      // Inside the tap, so iOS lets the audio through.
      engine.unlock();
      handle.current?.cancel();
      engine.cancel();
      setPreviewing(voiceId);
      const utterance = engine.speak(
        { text, voiceId, rate },
        {
          onEnd: () => {
            if (handle.current === utterance) {
              handle.current = null;
              setPreviewing(null);
            }
          },
          onError: () => {
            if (handle.current === utterance) {
              handle.current = null;
              setPreviewing(null);
            }
          },
        },
      );
      handle.current = utterance;
    },
    [engine, rate, previewing, stop],
  );

  useEffect(() => stop, [stop]);

  return { previewing, preview, stop };
}
