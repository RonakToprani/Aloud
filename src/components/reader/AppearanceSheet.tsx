"use client";

import { Field, Segmented, Slider } from "@/components/ui/Controls";
import { Sheet } from "@/components/ui/Sheet";
import {
  FONT_SIZE_RANGE,
  LINE_HEIGHT_RANGE,
  type AccentName,
  type HighlightStyle,
  type ReadingFace,
  type Settings,
  type ThemeName,
} from "@/lib/storage/prefs";
import styles from "./Sheets.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

const THEMES: { value: ThemeName; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "warm", label: "Warm" },
  { value: "light", label: "Light" },
  { value: "sepia", label: "Sepia" },
];

const HIGHLIGHTS: { value: HighlightStyle; label: string; hint: string }[] = [
  { value: "pill", label: "Pill", hint: "A tinted pill that moves between words" },
  { value: "wash", label: "Wash", hint: "A soft tint that fades from word to word" },
];

const ACCENTS: { value: AccentName; label: string }[] = [
  { value: "slate", label: "Slate" },
  { value: "violet", label: "Violet" },
  { value: "moss", label: "Moss" },
];

export function AppearanceSheet({ open, onClose, settings, update }: Props) {
  return (
    <Sheet open={open} title="Appearance" onClose={onClose}>
      <Field label="Theme">
        <div className={styles.themeGrid}>
          {THEMES.map((theme) => (
            <button
              key={theme.value}
              type="button"
              role="radio"
              aria-checked={settings.theme === theme.value}
              className={styles.themeOption}
              onClick={() => update({ theme: theme.value })}
            >
              <span
                className={styles.themeSwatch}
                data-theme={theme.value}
                data-active={settings.theme === theme.value ? "true" : undefined}
              >
                <span className={styles.themeAa}>Aa</span>
              </span>
              <span
                className={styles.themeName}
                data-active={settings.theme === theme.value ? "true" : undefined}
              >
                {theme.label}
              </span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Highlight">
        <div className={styles.highlightGrid}>
          {HIGHLIGHTS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={settings.highlight === option.value}
              aria-label={`${option.label} — ${option.hint}`}
              className={styles.highlightCard}
              data-active={settings.highlight === option.value ? "true" : undefined}
              onClick={() => update({ highlight: option.value })}
            >
              <span className={styles.highlightPreview} aria-hidden="true">
                off their{" "}
                <span className={option.value === "pill" ? styles.previewPill : styles.previewWash}>
                  hinges
                </span>
              </span>
              <span
                className={styles.highlightName}
                data-active={settings.highlight === option.value ? "true" : undefined}
              >
                {option.label}
              </span>
            </button>
          ))}
        </div>
      </Field>

      <Field label="Accent">
        <div className={styles.accentGrid}>
          {ACCENTS.map((accent) => (
            <button
              key={accent.value}
              type="button"
              role="radio"
              aria-checked={settings.accent === accent.value}
              className={styles.themeOption}
              onClick={() => update({ accent: accent.value })}
            >
              <span
                className={styles.accentSwatch}
                data-accent={accent.value}
                data-active={settings.accent === accent.value ? "true" : undefined}
              >
                <span className={styles.accentDot} />
              </span>
              <span
                className={styles.themeName}
                data-active={settings.accent === accent.value ? "true" : undefined}
              >
                {accent.label}
              </span>
            </button>
          ))}
        </div>
        <p className={styles.accentSpecimen} aria-hidden="true">
          taken off their{" "}
          <span className={settings.highlight === "pill" ? styles.previewPill : styles.previewWash}>
            hinges
          </span>
          ; Rumpelmayer&rsquo;s men were coming.
        </p>
      </Field>

      <Field label="Text">
        <Slider
          label="Text size"
          min={FONT_SIZE_RANGE.min}
          max={FONT_SIZE_RANGE.max}
          step={FONT_SIZE_RANGE.step}
          value={settings.fontSize}
          onChange={(fontSize) => update({ fontSize })}
          format={(value) => `${value} pixels`}
          leading={<span className={styles.sizeSmall}>A</span>}
          trailing={<span className={styles.sizeLarge}>A</span>}
        />
        <Slider
          label="Line spacing"
          min={LINE_HEIGHT_RANGE.min}
          max={LINE_HEIGHT_RANGE.max}
          step={LINE_HEIGHT_RANGE.step}
          value={settings.lineHeight}
          onChange={(lineHeight) => update({ lineHeight })}
          format={(value) => `${value.toFixed(2)} lines`}
          leading={LINE_HEIGHT_RANGE.min.toFixed(2)}
          trailing={LINE_HEIGHT_RANGE.max.toFixed(2)}
        />
      </Field>

      <Segmented<ReadingFace>
        label="Typeface"
        value={settings.face}
        onChange={(face) => update({ face })}
        options={[
          { value: "serif", label: <span className={styles.serifSample}>Serif</span> },
          { value: "sans", label: <span className={styles.sansSample}>Sans</span> },
        ]}
      />
    </Sheet>
  );
}
