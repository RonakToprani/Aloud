"use client";

import { Field, Slider } from "@/components/ui/Controls";
import { Sheet } from "@/components/ui/Sheet";
import { useOfflineVoice } from "@/lib/hooks/useOfflineVoice";
import type { EngineVoice } from "@/lib/speech/engine";
import { RATE_STEPS } from "@/lib/storage/prefs";
import styles from "./Sheets.module.css";
import { VoiceList } from "./VoiceList";

interface Props {
  open: boolean;
  onClose: () => void;
  rate: number;
  onRate: (rate: number) => void;
  voiceId: string | null;
  onVoice: (voiceId: string) => void;
  voices: EngineVoice[];
  preferredLang: string;
  voicesReady: boolean;
  /** Shown when the walkthrough sent the reader here. */
  tip?: string | null;
  previewing: string | null;
  onPreview: (voiceId: string) => void;
  sleepMinutes: number | null;
  sleepRemaining: number | null;
  onSleep: (minutes: number | null) => void;
  /** Render the open chapter with the offline voice, for reading with no
   *  connection. Absent where the offline voice cannot run. */
  onPrepareOffline?: () => void;
  onStopPreparing?: () => void;
  /** The offline voice a prepared chapter would be read in. */
  offlineVoiceName?: string;
}

const SLEEP_OPTIONS = [15, 30, 45, 60];

function nearestRateIndex(rate: number): number {
  let best = 0;
  let distance = Infinity;
  RATE_STEPS.forEach((step, index) => {
    const delta = Math.abs(step - rate);
    if (delta < distance) {
      distance = delta;
      best = index;
    }
  });
  return best;
}

export function PlaybackSheet({
  open,
  onClose,
  rate,
  onRate,
  voiceId,
  onVoice,
  voices,
  preferredLang,
  voicesReady,
  tip,
  previewing,
  onPreview,
  sleepMinutes,
  sleepRemaining,
  onSleep,
  onPrepareOffline,
  onStopPreparing,
  offlineVoiceName,
}: Props) {
  const rateIndex = nearestRateIndex(rate);
  const offline = useOfflineVoice(voiceId);
  const preparing = offline.preparing;

  return (
    <Sheet open={open} title="Voice & speed" onClose={onClose} tall tip={tip}>
      <Field label={`Speed ${rate.toFixed(2).replace(/0$/, "")}×`}>
        <Slider
          label="Reading speed"
          min={0}
          max={RATE_STEPS.length - 1}
          step={1}
          value={rateIndex}
          onChange={(index) => onRate(RATE_STEPS[index])}
          format={(index) => `${RATE_STEPS[index]} times`}
          leading="0.5×"
          trailing="2.5×"
        />
      </Field>

      <Field label="Sleep timer">
        <div className={styles.chips}>
          <button
            type="button"
            className={styles.chip}
            data-active={sleepMinutes === null ? "true" : undefined}
            onClick={() => onSleep(null)}
          >
            Off
          </button>
          {SLEEP_OPTIONS.map((minutes) => (
            <button
              key={minutes}
              type="button"
              className={styles.chip}
              data-active={sleepMinutes === minutes ? "true" : undefined}
              onClick={() => onSleep(minutes)}
            >
              {minutes}m
            </button>
          ))}
        </div>
        {sleepRemaining !== null && (
          <p className={styles.hint}>
            Stopping in {Math.max(1, Math.ceil(sleepRemaining / 60000))} minutes.
          </p>
        )}
      </Field>

      <Field label="Voice">
        <VoiceList
          voices={voices}
          preferredLang={preferredLang}
          voiceId={voiceId}
          onVoice={onVoice}
          ready={voicesReady}
          onPreview={onPreview}
          previewing={previewing}
        />
      </Field>

      {/* Only once the model is here: before that the download is the step
          that matters, and the voice list is already asking for it. */}
      {onPrepareOffline && offline.downloaded && (
        <Field label="Read offline">
          {preparing ? (
            <div className={styles.offlineNote}>
              <div
                className={styles.progress}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={preparing.total}
                aria-valuenow={preparing.done}
                aria-label="Preparing this chapter"
              >
                <span
                  className={styles.progressBar}
                  style={{ width: `${Math.max(2, Math.round((preparing.done / Math.max(1, preparing.total)) * 100))}%` }}
                />
                <span className={styles.progressLabel}>
                  {preparing.active
                    ? `Preparing this chapter: ${preparing.done} of ${preparing.total} sentences`
                    : "This chapter is ready to read offline."}
                </span>
              </div>
              {preparing.active && onStopPreparing && (
                <button type="button" className={styles.moreVoices} onClick={onStopPreparing}>
                  Stop preparing
                </button>
              )}
            </div>
          ) : (
            <div className={styles.offlineNote}>
              <button type="button" className={styles.prepare} onClick={onPrepareOffline}>
                Prepare this chapter for offline
              </button>
              <p className={styles.hint}>
                Reads every sentence of this chapter with {offlineVoiceName ?? "the offline voice"} on this
                device now, so it plays straight through with no connection. A few minutes on a phone;
                best done plugged in.
              </p>
            </div>
          )}
        </Field>
      )}
    </Sheet>
  );
}
