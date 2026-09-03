"use client";

import { useEffect, useMemo, useState } from "react";
import type { EngineVoice, SpeechEngine } from "@/lib/speech/engine";
import { getSpeechEngine } from "@/lib/speech/webSpeechEngine";

export interface VoiceGroup {
  lang: string;
  label: string;
  voices: EngineVoice[];
}

export interface SpeechEngineState {
  engine: SpeechEngine;
  voices: EngineVoice[];
  groups: VoiceGroup[];
  /** False until getVoices() has resolved (or timed out). */
  ready: boolean;
  supported: boolean;
}

function languageLabel(lang: string): string {
  try {
    const display = new Intl.DisplayNames(undefined, { type: "language" });
    return display.of(lang.replace("_", "-")) ?? lang;
  } catch {
    return lang;
  }
}

/** Higher-quality local voices first, then everything else alphabetically. */
function groupVoices(voices: EngineVoice[], preferredLang: string): VoiceGroup[] {
  const byLang = new Map<string, EngineVoice[]>();
  for (const voice of voices) {
    const key = voice.lang || "und";
    const list = byLang.get(key) ?? [];
    list.push(voice);
    byLang.set(key, list);
  }

  const groups: VoiceGroup[] = [...byLang.entries()].map(([lang, list]) => ({
    lang,
    label: languageLabel(lang),
    voices: list.sort(
      (a, b) => b.quality - a.quality || Number(b.local) - Number(a.local) || a.name.localeCompare(b.name),
    ),
  }));

  const base = preferredLang.split("-")[0];
  return groups.sort((a, b) => {
    const aExact = a.lang === preferredLang ? 2 : a.lang.startsWith(base) ? 1 : 0;
    const bExact = b.lang === preferredLang ? 2 : b.lang.startsWith(base) ? 1 : 0;
    return bExact - aExact || a.label.localeCompare(b.label);
  });
}

export function useSpeechEngine(): SpeechEngineState {
  const engine = useMemo(() => getSpeechEngine(), []);
  const [voices, setVoices] = useState<EngineVoice[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const unsubscribe = engine.subscribeVoices((next) => {
      if (alive) setVoices(next);
    });
    engine.ready().then(() => {
      if (!alive) return;
      setVoices(engine.listVoices());
      setReady(true);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [engine]);

  const preferredLang =
    typeof navigator !== "undefined" ? navigator.language || "en-US" : "en-US";
  const groups = useMemo(() => groupVoices(voices, preferredLang), [voices, preferredLang]);

  return { engine, voices, groups, ready, supported: engine.supported };
}

/** The voice we pick when the reader hasn't chosen one. */
export function pickDefaultVoice(voices: EngineVoice[], preferredLang: string): EngineVoice | null {
  if (!voices.length) return null;
  const base = preferredLang.split("-")[0].toLowerCase();
  const candidates = voices.filter((v) => v.lang.toLowerCase().startsWith(base));
  const pool = candidates.length ? candidates : voices;
  return [...pool].sort(
    (a, b) =>
      b.quality - a.quality ||
      Number(b.isDefault) - Number(a.isDefault) ||
      Number(b.local) - Number(a.local),
  )[0];
}
