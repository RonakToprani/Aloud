"use client";

import { formatInteger, formatListened, plural } from "@/lib/sync/format";
import { useReadingStats } from "@/lib/sync/stats";
import { useCountUp } from "./useCountUp";
import styles from "./Home.module.css";

/**
 * The home hero: how much has been read aloud, by how many, and how many
 * are listening this minute. Counts on load rather than landing, holds the
 * last cached figure until a fresh one arrives, and never shows a skeleton.
 */
export function StatsHero() {
  const stats = useReadingStats();
  const seconds = useCountUp(stats.totalSeconds);
  if (!stats.available) return null;
  const { figure, unit } = formatListened(seconds);

  return (
    <div className={styles.hero}>
      <span className={styles.eyebrow}>Read aloud so far</span>
      <span className={styles.counter} aria-live="off">
        {figure}
      </span>
      <span className={styles.readers}>
        {unit}, by {plural(stats.readers, "reader", "readers")}
      </span>
      <Presence listeningNow={stats.listeningNow} activeReaders={stats.activeReaders} />
    </div>
  );
}

function Presence({ listeningNow, activeReaders }: { listeningNow: number; activeReaders: number }) {
  if (listeningNow > 0) {
    return (
      <span className={styles.presence}>
        <span className={styles.presenceDot} data-live="true" aria-hidden="true" />
        {plural(listeningNow, "listening right now", "listening right now")}
      </span>
    );
  }
  if (activeReaders > 0) {
    return (
      <span className={styles.presence}>
        <span className={styles.presenceDot} aria-hidden="true" />
        {plural(activeReaders, "reader this week", "readers this week")}
      </span>
    );
  }
  return null;
}

/** The same figures, one quiet line, above a populated library. */
export function StatsStrip() {
  const stats = useReadingStats();
  if (!stats.available || (stats.totalSeconds === 0 && stats.readers === 0)) return null;
  const { figure, unit } = formatListened(stats.totalSeconds);

  return (
    <p className={styles.strip}>
      <span className={styles.stripFigure}>{figure}</span> {unit} read aloud
      <span className={styles.stripDot}>·</span>
      {plural(stats.readers, "reader", "readers")}
      {stats.listeningNow > 0 && (
        <>
          <span className={styles.stripDot}>·</span>
          <span className={styles.presenceDot} data-live="true" aria-hidden="true" />
          {formatInteger(stats.listeningNow)} listening now
        </>
      )}
      {stats.listeningNow === 0 && stats.activeReaders > 0 && (
        <>
          <span className={styles.stripDot}>·</span>
          {formatInteger(stats.activeReaders)} active this week
        </>
      )}
    </p>
  );
}
