import styles from "./Logo.module.css";

/**
 * The mark is the reading highlight itself: a word inside a tinted pill. It
 * uses the same --word / --word-ink tokens the reader paints on the spoken
 * word, so the brand and the core interaction are the same object.
 *
 * There is deliberately no container tile here. The tile belongs to the app
 * icon, where it sits on a home screen; in the interface it would be a
 * near-white square on a near-white canvas in the light and sepia themes.
 */
export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect x="0" y="2" width="32" height="28" rx="9" fill="var(--word)" />
      <text
        x="16"
        y="23.4"
        textAnchor="middle"
        fontFamily="var(--font-serif)"
        fontSize="21"
        fontWeight="500"
        fill="var(--word-ink)"
      >
        a
      </text>
    </svg>
  );
}

interface LogoProps {
  /** Height of the mark; the wordmark scales with it. */
  size?: number;
  /** Hide the wordmark, leaving just the mark. */
  markOnly?: boolean;
  className?: string;
}

export function Logo({ size = 30, markOnly = false, className }: LogoProps) {
  return (
    <span className={`${styles.lockup} ${className ?? ""}`} style={{ ["--mark" as string]: `${size}px` }}>
      <LogoMark size={size} />
      {!markOnly && <span className={styles.word}>Aloud</span>}
      <span className="srOnly">Aloud</span>
    </span>
  );
}
