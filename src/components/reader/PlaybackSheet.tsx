"use client";

import { Field, Slider } from "@/components/ui/Controls";
import { CheckIcon } from "@/components/ui/Icons";
import { Sheet } from "@/components/ui/Sheet";
import type { VoiceGroup } from "@/lib/hooks/useSpeechEngine";
import { RATE_STEPS } from "@/lib/storage/prefs";
import styles from "./Sheets.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  rate: number;
  onRate: (rate: number) => void;
  voiceId: string | null;
  onVoice: (voiceId: string) => void;
  groups: VoiceGroup[];
  voicesReady: boolean;
  sleepMinutes: number | null;
  sleepRemaining: number | null;
  onSleep: (minutes: number | null) => void;
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
  groups,
  voicesReady,
  sleepMinutes,
  sleepRemaining,
  onSleep,
}: Props) {
  const rateIndex = nearestRateIndex(rate);

  return (
    <Sheet open={open} title="Voice & speed" onClose={onClose} tall>
      <Field label={`Speed — ${rate.toFixed(2).replace(/0$/, "")}×`}>
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
        {!voicesReady && <p className={styles.hint}>Looking for voices on this device…</p>}
        {voicesReady && !groups.length && (
          <p className={styles.hint}>
            This device reports no speech voices. On iOS they arrive with the first system voice
            download; on desktop Linux a speech engine such as speech-dispatcher must be installed.
          </p>
        )}
        <div className={styles.voiceList}>
          {groups.map((group) => (
            <div key={group.lang} className={styles.voiceGroup}>
              <div className={styles.voiceGroupLabel}>{group.label}</div>
              {group.voices.map((voice) => (
                <button
                  key={voice.id}
                  type="button"
                  role="radio"
                  aria-checked={voice.id === voiceId}
                  className={styles.voiceRow}
                  data-active={voice.id === voiceId ? "true" : undefined}
                  onClick={() => onVoice(voice.id)}
                >
                  <span className={styles.voiceName}>{voice.name}</span>
                  <span className={styles.voiceMeta}>
                    {voice.local && <span className={styles.badge}>On device</span>}
                    {voice.id === voiceId && <CheckIcon size={16} />}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </Field>
    </Sheet>
  );
}
