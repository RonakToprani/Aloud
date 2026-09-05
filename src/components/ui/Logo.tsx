import styles from "./Logo.module.css";

/**
 * The mark is the product's one real gesture, drawn without letters: three
 * lines of text, and one word on the middle line lit by the reading pill.
 * The lines take the ink colour and the pill takes the same --word token the
 * reader paints on the spoken word, so brand and interaction stay one object
 * and the mark follows the reader's theme and accent.
 *
 * Geometry lives in `LOGO_GEOMETRY` so the app icon generator can render
 * exactly the same shape at any size without a font.
 */
export const LOGO_GEOMETRY = {
  viewBox: 32,
  stroke: 3.4,
  lines: [
    { y: 8, x1: 5, x2: 27 },
    { y: 24, x1: 5, x2: 21 },
  ],
  /** The lit word: a pill on the middle line, with the line resuming after it. */
  pill: { x: 5, y: 12.2, width: 13, height: 7.6, radius: 3.8 },
  tail: { y: 16, x1: 22, x2: 27 },
} as const;

interface MarkProps {
  size?: number;
  className?: string;
  /** Override the ink colour; defaults to the current text colour. */
  ink?: string;
  /** Override the pill colour; defaults to the reader's word-pill token. */
  pill?: string;
}

export function LogoMark({ size = 32, className, ink = "currentColor", pill = "var(--word)" }: MarkProps) {
  const g = LOGO_GEOMETRY;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${g.viewBox} ${g.viewBox}`}
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {g.lines.map((line) => (
        <path
          key={line.y}
          d={`M${line.x1} ${line.y}H${line.x2}`}
          stroke={ink}
          strokeWidth={g.stroke}
          strokeLinecap="round"
        />
      ))}
      <rect
        x={g.pill.x}
        y={g.pill.y}
        width={g.pill.width}
        height={g.pill.height}
        rx={g.pill.radius}
        fill={pill}
      />
      <path
        d={`M${g.tail.x1} ${g.tail.y}H${g.tail.x2}`}
        stroke={ink}
        strokeWidth={g.stroke}
        strokeLinecap="round"
      />
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

export function Logo({ size = 26, markOnly = false, className }: LogoProps) {
  return (
    <span className={`${styles.lockup} ${className ?? ""}`} style={{ ["--mark" as string]: `${size}px` }}>
      <LogoMark size={size} className={styles.mark} />
      {!markOnly && <span className={styles.word}>Aloud</span>}
      <span className="srOnly">Aloud</span>
    </span>
  );
}
