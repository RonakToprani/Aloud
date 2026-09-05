"use client";

import { useEffect, useState } from "react";
import { AddSquareIcon, MoreIcon, ShareIcon } from "@/components/ui/Icons";
import styles from "@/components/auth/SignIn.module.css";
import {
  canPromptInstall,
  isInAppBrowser,
  isStandalone,
  markHomeScreenDone,
  platform,
  promptInstall,
  type Platform,
} from "./installPrompt";

interface Props {
  /** Called once the reader has added the app or chosen to move on. */
  onDone: () => void;
}

/**
 * One screen, shown once, in the sign-up flow: put Aloud on the home
 * screen. Saved to the home screen the app opens full-screen, keeps its
 * audio session, and shows lock-screen controls — it is the difference
 * between a website and the thing the reader actually wanted.
 */
export function HomeScreenStep({ onDone }: Props) {
  const [os, setOs] = useState<Platform>("desktop");
  const [inApp, setInApp] = useState(false);
  const [installable, setInstallable] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    setOs(platform());
    setInApp(isInAppBrowser());
    setInstallable(canPromptInstall());
    setInstalled(isStandalone());
  }, []);

  const finish = () => {
    markHomeScreenDone();
    onDone();
  };

  const install = async () => {
    const outcome = await promptInstall();
    if (outcome === "accepted") setInstalled(true);
    setInstallable(canPromptInstall());
  };

  return (
    <main className={styles.page}>
      <div className={styles.body}>
        <div className={styles.heading}>
          <h1 className={styles.title}>Keep Aloud on your home screen</h1>
          <p className={styles.subtitle}>
            Saved there, it opens full-screen, keeps reading with the phone locked, and puts
            play and pause on the lock screen. Takes a moment, once.
          </p>
        </div>

        {inApp && (
          <p className={styles.note}>
            This page opened inside another app. Tap the menu and choose{" "}
            <strong>Open in {os === "ios" ? "Safari" : "browser"}</strong> first, then follow the
            steps there.
          </p>
        )}

        {installed ? (
          <p className={styles.quiet}>It&rsquo;s on your home screen. Open it from there from now on.</p>
        ) : os === "ios" ? (
          <ol className={styles.steps}>
            <li className={styles.step}>
              <span className={styles.stepNumber}>1</span>
              <span>
                Tap the Share button <ShareIcon size={16} /> at the bottom of Safari.
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>2</span>
              <span>
                Scroll down and tap <strong>Add to Home Screen</strong> <AddSquareIcon size={16} />.
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>3</span>
              <span>
                Tap <strong>Add</strong> in the top corner, then come back here.
              </span>
            </li>
          </ol>
        ) : installable ? (
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={() => void install()}>
              <AddSquareIcon size={16} />
              Add to home screen
            </button>
          </div>
        ) : (
          <ol className={styles.steps}>
            <li className={styles.step}>
              <span className={styles.stepNumber}>1</span>
              <span>
                Tap the browser menu <MoreIcon size={16} /> in the top corner.
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>2</span>
              <span>
                Choose <strong>Add to Home screen</strong> or <strong>Install app</strong>.
              </span>
            </li>
            <li className={styles.step}>
              <span className={styles.stepNumber}>3</span>
              <span>
                Confirm, then come back here.
              </span>
            </li>
          </ol>
        )}
      </div>

      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={finish}>
          {installed ? "Continue" : "I've added it — continue"}
        </button>
        {!installed && (
          <button type="button" className={styles.skip} onClick={finish}>
            Not now
          </button>
        )}
      </div>
    </main>
  );
}
