"use client";

import { useEffect, useState } from "react";
import { AddSquareIcon, MoreIcon, ShareIcon } from "@/components/ui/Icons";
import styles from "./HomeScreenNote.module.css";
import {
  canPromptInstall,
  homeScreenNoteDone,
  isInAppBrowser,
  markHomeScreenDone,
  markHomeScreenNoteDone,
  platform,
  promptInstall,
  shouldShowHomeScreenStep,
  type Platform,
} from "./installPrompt";

interface Props {
  /** Copy that fits where it sits; the steps below it are the same either way. */
  title?: string;
}

/**
 * The same offer as the sign-up step, made where the reader has just finished
 * something and has a reason to want it again: on the home screen Aloud opens
 * full-screen, keeps reading with the phone locked, and puts play and pause on
 * the lock screen.
 *
 * Rendered only after mount, because whether it has anything to say depends on
 * the device and on localStorage, neither of which the server knows.
 */
export function HomeScreenNote({ title = "Keep Aloud on your home screen" }: Props) {
  const [show, setShow] = useState(false);
  const [os, setOs] = useState<Platform>("desktop");
  const [inApp, setInApp] = useState(false);
  const [installable, setInstallable] = useState(false);

  useEffect(() => {
    if (!shouldShowHomeScreenStep() || homeScreenNoteDone()) return;
    setOs(platform());
    setInApp(isInAppBrowser());
    setInstallable(canPromptInstall());
    setShow(true);
  }, []);

  if (!show) return null;

  // Safari never offers a prompt to fire; on iOS the steps are the only path,
  // whatever a stray beforeinstallprompt may have said.
  const canInstall = installable && !inApp && os !== "ios";

  // Waving this away only closes this one. Adding it to the home screen is
  // the thing that settles the question, and that closes both.
  const dismiss = () => {
    markHomeScreenNoteDone();
    setShow(false);
  };

  const install = async () => {
    const outcome = await promptInstall();
    if (outcome === "accepted") {
      markHomeScreenDone();
      dismiss();
    } else {
      setInstallable(canPromptInstall());
    }
  };

  return (
    <div className={styles.note}>
      <p className={styles.title}>{title}</p>
      <p className={styles.body}>
        It opens full-screen, keeps reading with the phone locked, and puts play and pause on the
        lock screen. Takes a moment, once.
      </p>

      {inApp ? (
        <p className={styles.body}>
          This page opened inside another app. Tap its menu and choose{" "}
          <strong>Open in {os === "ios" ? "Safari" : "browser"}</strong> first, then follow the
          steps there.
        </p>
      ) : os === "ios" ? (
        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <span>
              Tap the Share button <ShareIcon size={15} /> at the bottom of Safari.
            </span>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>2</span>
            <span>
              Scroll down and tap <strong>Add to Home Screen</strong> <AddSquareIcon size={15} />.
            </span>
          </li>
          <li className={styles.step}>
            <span className={styles.stepNumber}>3</span>
            <span>
              Tap <strong>Add</strong> in the top corner. Aloud is on your home screen.
            </span>
          </li>
        </ol>
      ) : canInstall ? null : (
        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.stepNumber}>1</span>
            <span>
              Tap the browser menu <MoreIcon size={15} /> in the top corner.
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
            <span>Confirm, and Aloud is on your home screen.</span>
          </li>
        </ol>
      )}

      <div className={styles.actions}>
        {canInstall && (
          <button type="button" className={styles.primary} onClick={() => void install()}>
            <AddSquareIcon size={15} />
            Add to home screen
          </button>
        )}
        <button type="button" className={styles.dismiss} onClick={dismiss}>
          {canInstall ? "Not now" : "Got it"}
        </button>
      </div>
    </div>
  );
}
