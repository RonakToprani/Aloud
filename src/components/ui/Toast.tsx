"use client";

import { useEffect, useRef } from "react";
import styles from "./Toast.module.css";

export interface ToastMessage {
  id: number;
  text: string;
  /** Optional single action, used for undoing a deletion. */
  action?: { label: string; onAction: () => void };
  durationMs?: number;
}

interface Props {
  toast: ToastMessage | null;
  onDismiss: () => void;
}

export function Toast({ toast, onDismiss }: Props) {
  // Keeping the callback in a ref stops a parent re-render from restarting the
  // dismiss countdown, which would leave an undo offer up long after its window
  // had actually closed.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dismissRef.current(), toast.durationMs ?? 5200);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) return null;

  return (
    <div className={styles.wrap} role="status" aria-live="polite">
      <div className={styles.toast}>
        <span className={styles.text}>{toast.text}</span>
        {toast.action && (
          <button
            type="button"
            className={styles.action}
            onClick={() => {
              toast.action?.onAction();
              onDismiss();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
    </div>
  );
}
