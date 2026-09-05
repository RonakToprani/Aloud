"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { Sheet } from "@/components/ui/Sheet";
import { localListenedSeconds } from "@/lib/sync/listening";
import { pullWeek } from "@/lib/sync/remote";
import styles from "./Account.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

const DAY = ["M", "T", "W", "T", "F", "S", "S"];

/** Who's signed in, what they've listened to this week, and the way out. */
export function AccountSheet({ open, onClose }: Props) {
  const { status, email, signOut } = useAuth();
  const [week, setWeek] = useState<number[] | null>(null);
  const [local, setLocal] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLocal(localListenedSeconds());
    void pullWeek().then(setWeek);
  }, [open]);

  const total = week ? week.reduce((a, b) => a + b, 0) : local;
  const peak = week ? Math.max(1, ...week) : 1;
  const todayIndex = (new Date().getDay() + 6) % 7;

  return (
    <Sheet open={open} title="Account" onClose={onClose}>
      <div className={styles.who}>
        {status === "signed-in" ? (
          <>
            <span className={styles.label}>Signed in as</span>
            <span className={styles.email}>{email}</span>
          </>
        ) : (
          <>
            <span className={styles.label}>Reading without an account</span>
            <span className={styles.hint}>
              Sign in to keep your library and your place in it on every device.
            </span>
          </>
        )}
      </div>

      <div className={styles.week}>
        <span className={styles.label}>This week</span>
        <span className={styles.total}>{formatDuration(total)}</span>
        {week && (
          <div className={styles.bars} aria-hidden="true">
            {week.map((seconds, index) => {
              const day = (todayIndex - 6 + index + 7) % 7;
              return (
                <span key={index} className={styles.barColumn}>
                  <span
                    className={styles.bar}
                    data-today={index === 6 ? "true" : undefined}
                    style={{ height: `${Math.max(6, (seconds / peak) * 100)}%` }}
                  />
                  <span className={styles.barLabel}>{DAY[day]}</span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {status === "signed-in" ? (
        <button
          type="button"
          className={styles.signOut}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await signOut();
            setBusy(false);
            onClose();
          }}
        >
          {busy ? "Signing out…" : "Sign out"}
        </button>
      ) : (
        <Link href="/signin" className={styles.signIn} onClick={onClose}>
          Sign in
        </Link>
      )}
      <p className={styles.footnote}>Books stay yours. We store your progress, not your files.</p>
    </Sheet>
  );
}
