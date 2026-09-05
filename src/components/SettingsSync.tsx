"use client";

import { useEffect, useRef } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useSettings } from "@/components/SettingsProvider";
import { normalizeSettings } from "@/lib/storage/prefs";
import { pullSettings, pushSettings } from "@/lib/sync/remote";

/** How long after the last change a settings write waits, so a slider drag
 *  is one request rather than sixty. */
const PUSH_DEBOUNCE_MS = 900;

/**
 * Keeps the reader's settings the same on every device. Newest copy wins,
 * judged by the clock stamp each device puts on its own changes. Renders
 * nothing.
 */
export function SettingsSync() {
  const { userId, epoch } = useAuth();
  const { settings, replace, ready } = useSettings();
  const syncedAt = useRef(0);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // On every account change: reconcile once.
  useEffect(() => {
    if (!userId || !ready) return;
    let alive = true;
    (async () => {
      const remote = await pullSettings().catch(() => null);
      if (!alive) return;
      const local = settingsRef.current;
      if (remote && remote.updatedAt > local.updatedAt) {
        syncedAt.current = remote.updatedAt;
        replace(normalizeSettings({ ...remote.settings, updatedAt: remote.updatedAt }));
      } else if (local.updatedAt > (remote?.updatedAt ?? 0)) {
        syncedAt.current = local.updatedAt;
        await pushSettings(local).catch(() => {});
      } else {
        syncedAt.current = local.updatedAt;
      }
    })();
    return () => {
      alive = false;
    };
  }, [userId, epoch, ready, replace]);

  // Afterwards: push local changes, debounced.
  useEffect(() => {
    if (!userId || !ready) return;
    if (settings.updatedAt <= syncedAt.current) return;
    const timer = setTimeout(() => {
      syncedAt.current = settings.updatedAt;
      void pushSettings(settings).catch(() => {});
    }, PUSH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [settings, userId, ready]);

  return null;
}
