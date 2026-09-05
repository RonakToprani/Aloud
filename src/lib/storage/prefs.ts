import type { Position } from "@/lib/types";

export type ThemeName = "dark" | "warm" | "light" | "sepia";
export type HighlightStyle = "pill" | "wash";
export type ReadingFace = "serif" | "sans";
export type AccentName = "slate" | "violet" | "moss";

export interface Settings {
  theme: ThemeName;
  highlight: HighlightStyle;
  face: ReadingFace;
  /** Reading text size in px. */
  fontSize: number;
  lineHeight: number;
  rate: number;
  voiceId: string | null;
  /** A hue rotation for the highlight and controls. Slate follows the theme. */
  accent: AccentName;
  /** When these settings last changed, so two devices can agree which copy wins. */
  updatedAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  highlight: "pill",
  face: "serif",
  fontSize: 19,
  lineHeight: 1.72,
  rate: 1,
  voiceId: null,
  accent: "slate",
  updatedAt: 0,
};

export const FONT_SIZE_RANGE = { min: 16, max: 26, step: 1 };
export const LINE_HEIGHT_RANGE = { min: 1.45, max: 1.95, step: 0.01 };
/** Fine steps where people actually live, coarser at the extremes. */
export const RATE_STEPS = [
  0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45,
  1.5, 1.55, 1.6, 1.7, 1.8, 1.9, 2, 2.25, 2.5,
];

const SETTINGS_KEY = "aloud.settings.v1";
const POSITION_PREFIX = "aloud.position.";

function readJson<T>(key: string): T | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode or a full quota — settings just don't persist */
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Coerce any stored or synced object into a valid Settings. */
export function normalizeSettings(stored: Partial<Settings> | null | undefined): Settings {
  if (!stored) return { ...DEFAULT_SETTINGS };
  return {
    theme: (["dark", "warm", "light", "sepia"] as const).includes(stored.theme as ThemeName)
      ? (stored.theme as ThemeName)
      : DEFAULT_SETTINGS.theme,
    highlight: stored.highlight === "wash" ? "wash" : "pill",
    face: stored.face === "sans" ? "sans" : "serif",
    fontSize: clamp(
      Number(stored.fontSize) || DEFAULT_SETTINGS.fontSize,
      FONT_SIZE_RANGE.min,
      FONT_SIZE_RANGE.max,
    ),
    lineHeight: clamp(
      Number(stored.lineHeight) || DEFAULT_SETTINGS.lineHeight,
      LINE_HEIGHT_RANGE.min,
      LINE_HEIGHT_RANGE.max,
    ),
    rate: clamp(Number(stored.rate) || DEFAULT_SETTINGS.rate, 0.5, 2.5),
    voiceId: typeof stored.voiceId === "string" ? stored.voiceId : null,
    accent: (["slate", "violet", "moss"] as const).includes(stored.accent as AccentName)
      ? (stored.accent as AccentName)
      : DEFAULT_SETTINGS.accent,
    updatedAt: Number(stored.updatedAt) || 0,
  };
}

export function loadSettings(): Settings {
  return normalizeSettings(readJson<Partial<Settings>>(SETTINGS_KEY));
}

/** The keys a reader actually chooses; `updatedAt` is bookkeeping. */
export function settingsEqual(a: Settings, b: Settings): boolean {
  return (
    a.theme === b.theme &&
    a.highlight === b.highlight &&
    a.face === b.face &&
    a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight &&
    a.rate === b.rate &&
    a.voiceId === b.voiceId &&
    a.accent === b.accent
  );
}

export function saveSettings(settings: Settings): void {
  writeJson(SETTINGS_KEY, settings);
}

export function loadPosition(bookId: string): Position | null {
  const stored = readJson<Position>(POSITION_PREFIX + bookId);
  if (!stored || typeof stored.chapterIndex !== "number") return null;
  return stored;
}

export function savePosition(bookId: string, position: Position): void {
  writeJson(POSITION_PREFIX + bookId, position);
}

export function clearPosition(bookId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(POSITION_PREFIX + bookId);
  } catch {
    /* ignore */
  }
}
