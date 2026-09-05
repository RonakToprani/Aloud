"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from "@/lib/storage/prefs";

interface SettingsContextValue {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** Adopt a whole settings object, as when another device's copy is newer. */
  replace: (next: Settings) => void;
  /** False until the stored settings have been read on the client. */
  ready: boolean;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    setSettings(loadSettings());
    setReady(true);
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    saveSettings(settings);
  }, [settings]);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.face = settings.face;
    root.dataset.highlight = settings.highlight;
    root.dataset.accent = settings.accent;
    root.style.setProperty("--reader-size", `${settings.fontSize}px`);
    root.style.setProperty("--reader-leading", String(settings.lineHeight));
  }, [
    settings.theme,
    settings.face,
    settings.highlight,
    settings.accent,
    settings.fontSize,
    settings.lineHeight,
  ]);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...patch, updatedAt: Date.now() }));
  }, []);

  /** Adopt settings from another device without bumping the local clock. */
  const replace = useCallback((next: Settings) => {
    setSettings(next);
  }, []);

  const value = useMemo(
    () => ({ settings, update, replace, ready }),
    [settings, update, replace, ready],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings must be used inside SettingsProvider");
  return value;
}
