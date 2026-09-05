"use client";

import { useEffect, useMemo } from "react";
import { PlayIcon } from "@/components/ui/Icons";
import { pickDefaultVoice } from "@/lib/hooks/useSpeechEngine";
import type { EngineVoice } from "@/lib/speech/engine";
import styles from "./VoiceChooser.module.css";
import { VoiceList } from "./VoiceList";

interface Props {
  bookTitle: string;
  voices: EngineVoice[];
  preferredLang: string;
  ready: boolean;
  voiceId: string | null;
  onVoice: (voiceId: string) => void;
  previewing: string | null;
  onPreview: (voiceId: string) => void;
  /** Commit the choice and start reading. */
  onStart: () => void;
}

/**
 * The first time a book is opened, the reader picks the voice that will
 * read it — and hears each candidate read the book's own opening before
 * deciding. Shown once per book; afterwards the voice lives in the reader's
 * playback sheet like any other setting.
 */
export function VoiceChooser({
  bookTitle,
  voices,
  preferredLang,
  ready,
  voiceId,
  onVoice,
  previewing,
  onPreview,
  onStart,
}: Props) {
  const chosen = useMemo(() => voices.find((voice) => voice.id === voiceId) ?? null, [voices, voiceId]);

  // Land on a sensible default so the big button is always one tap away.
  useEffect(() => {
    if (!ready || voiceId || !voices.length) return;
    const fallback = pickDefaultVoice(voices, preferredLang);
    if (fallback) onVoice(fallback.id);
  }, [ready, voiceId, voices, preferredLang, onVoice]);

  return (
    <div className={styles.page} role="dialog" aria-modal="true" aria-labelledby="voice-chooser-title">
      <div className={styles.scroll}>
        <header className={styles.head}>
          <span className={styles.eyebrow}>Before you start</span>
          <h1 id="voice-chooser-title" className={styles.title}>
            Choose a voice
          </h1>
          <p className={styles.lede}>
            Tap the speaker to hear each one read the opening of <em>{bookTitle}</em>. You can
            change your mind any time from the reader.
          </p>
        </header>

        <VoiceList
          voices={voices}
          preferredLang={preferredLang}
          voiceId={voiceId}
          onVoice={onVoice}
          ready={ready}
          onPreview={onPreview}
          previewing={previewing}
        />
      </div>

      <div className={styles.foot}>
        <button type="button" className={styles.start} disabled={!chosen} onClick={onStart}>
          <PlayIcon size={18} />
          {chosen ? `Read with ${chosen.name}` : "Choose a voice to begin"}
        </button>
      </div>
    </div>
  );
}
