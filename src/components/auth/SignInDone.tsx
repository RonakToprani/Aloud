"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { HomeScreenStep } from "@/components/install/HomeScreenStep";
import { shouldShowHomeScreenStep } from "@/components/install/installPrompt";
import styles from "./SignIn.module.css";

/** How long to wait for a link's session before assuming it was a dud. */
const PATIENCE_MS = 6000;

/**
 * Where a magic link lands, and where a verified code sends the reader.
 * Signed in, this is the one moment to ask for the home-screen install;
 * afterwards it goes straight to the library.
 */
export function SignInDone() {
  const router = useRouter();
  const { status } = useAuth();
  const [step, setStep] = useState<"waiting" | "install" | "failed">("waiting");

  useEffect(() => {
    if (status === "signed-in") {
      if (shouldShowHomeScreenStep()) setStep("install");
      else router.replace("/");
      return;
    }
    if (status === "unavailable") {
      router.replace("/");
      return;
    }
    const timer = setTimeout(() => setStep("failed"), PATIENCE_MS);
    return () => clearTimeout(timer);
  }, [status, router]);

  if (step === "install") return <HomeScreenStep onDone={() => router.replace("/")} />;

  return (
    <main className={styles.page}>
      <div className={styles.body}>
        {step === "failed" ? (
          <div className={styles.heading}>
            <h1 className={styles.title}>That link didn&rsquo;t work</h1>
            <p className={styles.subtitle}>
              It may have been used already, or expired. Ask for a fresh one and it&rsquo;ll get you
              in.
            </p>
            <div className={styles.actions} style={{ marginTop: 14 }}>
              <button type="button" className={styles.primary} onClick={() => router.replace("/signin")}>
                Send a new link
              </button>
            </div>
          </div>
        ) : (
          <p className={styles.quiet}>Signing you in…</p>
        )}
      </div>
    </main>
  );
}
