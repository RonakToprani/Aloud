"use client";

import styles from "./Controls.module.css";

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  /** Small marks at either end of the track, e.g. "A" and a larger "A". */
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  format?: (value: number) => string;
}

export function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  leading,
  trailing,
  format,
}: SliderProps) {
  const fraction = max > min ? (value - min) / (max - min) : 0;
  return (
    <div className={styles.sliderRow}>
      {leading !== undefined && (
        <span className={styles.sliderEnd} aria-hidden="true">
          {leading}
        </span>
      )}
      <input
        className={styles.slider}
        style={{ ["--fill" as string]: `${fraction * 100}%` }}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        aria-valuetext={format ? format(value) : undefined}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {trailing !== undefined && (
        <span className={`${styles.sliderEnd} ${styles.sliderEndTrailing}`} aria-hidden="true">
          {trailing}
        </span>
      )}
    </div>
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: { value: T; label: React.ReactNode; hint?: string }[];
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className={styles.segmented} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={styles.segment}
          data-active={value === option.value ? "true" : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div className={styles.fieldLabel}>{children}</div>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <FieldLabel>{label}</FieldLabel>
      {children}
    </div>
  );
}
