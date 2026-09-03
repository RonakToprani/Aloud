"use client";

import {
  ContentsIcon,
  LevelIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  TypeIcon,
  VoiceIcon,
} from "@/components/ui/Icons";
import styles from "./ControlBar.module.css";

interface Props {
  playing: boolean;
  expanded: boolean;
  onExpand: () => void;
  onToggle: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onAppearance: () => void;
  onPlayback: () => void;
  onContents: () => void;
  /** 0–1 through the whole book. */
  progress: number;
  minutesLeft: number | null;
  rate: number;
  sleepRemainingMs: number | null;
}

function formatRate(rate: number): string {
  return `${rate.toFixed(2).replace(/\.?0+$/, "")}×`;
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "";
  if (minutes < 1) return "under a minute left";
  if (minutes < 60) return `${Math.round(minutes)} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}

export function ControlBar({
  playing,
  expanded,
  onExpand,
  onToggle,
  onPrevious,
  onNext,
  onAppearance,
  onPlayback,
  onContents,
  progress,
  minutesLeft,
  rate,
  sleepRemainingMs,
}: Props) {
  const sleepLabel =
    sleepRemainingMs === null ? null : `sleep ${Math.max(1, Math.ceil(sleepRemainingMs / 60000))}m`;

  return (
    <div className={styles.dock} data-expanded={expanded ? "true" : "false"}>
      <div className={styles.fade} aria-hidden="true" />

      {/* While reading, the chrome recedes to a single quiet capsule. */}
      <button
        type="button"
        className={styles.capsule}
        onClick={onExpand}
        aria-hidden={expanded ? "true" : undefined}
        tabIndex={expanded ? -1 : 0}
        aria-label="Show playback controls"
      >
        <LevelIcon animated={playing} />
        {minutesLeft !== null && <span>{formatMinutes(minutesLeft)}</span>}
        <span className={styles.dot}>·</span>
        <span>{formatRate(rate)}</span>
        {sleepLabel && (
          <>
            <span className={styles.dot}>·</span>
            <span>{sleepLabel}</span>
          </>
        )}
      </button>

      <div className={styles.bar} aria-hidden={expanded ? undefined : "true"}>
        <div className={styles.progress}>
          <div
            className={styles.progressFill}
            style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }}
          />
        </div>

        <div className={styles.row}>
          <button
            type="button"
            className={styles.utility}
            onClick={onAppearance}
            tabIndex={expanded ? 0 : -1}
            aria-label="Appearance"
          >
            <TypeIcon />
          </button>

          <div className={styles.transport}>
            <button
              type="button"
              className={styles.step}
              onClick={onPrevious}
              tabIndex={expanded ? 0 : -1}
              aria-label="Previous sentence"
            >
              <PreviousIcon />
            </button>
            <button
              type="button"
              className={styles.play}
              onClick={onToggle}
              tabIndex={expanded ? 0 : -1}
              aria-label={playing ? "Pause" : "Play"}
            >
              {playing ? <PauseIcon size={24} /> : <PlayIcon size={24} />}
            </button>
            <button
              type="button"
              className={styles.step}
              onClick={onNext}
              tabIndex={expanded ? 0 : -1}
              aria-label="Next sentence"
            >
              <NextIcon />
            </button>
          </div>

          <div className={styles.utilityGroup}>
            <button
              type="button"
              className={styles.utility}
              onClick={onPlayback}
              tabIndex={expanded ? 0 : -1}
              aria-label="Voice and speed"
            >
              <VoiceIcon />
            </button>
            <button
              type="button"
              className={styles.utility}
              onClick={onContents}
              tabIndex={expanded ? 0 : -1}
              aria-label="Contents"
            >
              <ContentsIcon />
            </button>
          </div>
        </div>

        <div className={styles.status}>
          {minutesLeft !== null && <span>{formatMinutes(minutesLeft)}</span>}
          <span className={styles.statusRight}>
            <span className={styles.rateDot} aria-hidden="true" />
            {formatRate(rate)}
            {sleepLabel && <span className={styles.sleepTag}>{sleepLabel}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
