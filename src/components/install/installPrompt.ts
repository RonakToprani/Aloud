"use client";

/**
 * The "save Aloud to your home screen" step. Shown once, during sign-up, and
 * never again on this device.
 */

const DONE_KEY = "aloud.homescreen.v1";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;
let listening = false;

/** Chrome fires this once, early; it must be caught before the step mounts. */
export function catchInstallPrompt(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    markHomeScreenDone();
  });
}

export function canPromptInstall(): boolean {
  return deferredPrompt !== null;
}

export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const prompt = deferredPrompt;
  if (!prompt) return "unavailable";
  deferredPrompt = null;
  await prompt.prompt();
  const { outcome } = await prompt.userChoice;
  return outcome;
}

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.("(display-mode: standalone)").matches || nav.standalone === true;
}

export type Platform = "ios" | "android" | "desktop";

export function platform(): Platform {
  if (typeof navigator === "undefined") return "desktop";
  const ua = navigator.userAgent;
  // iPadOS reports itself as a Mac; the touch points give it away.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "ios";
  if (/Android/.test(ua)) return "android";
  return "desktop";
}

/** Mail apps and social apps open links in their own web view, which has no
 *  "Add to Home Screen". The reader needs to be told to switch to Safari. */
export function isInAppBrowser(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (platform() === "ios") return !/Safari/.test(ua) || /CriOS|FxiOS|GSA|Instagram|FBAN|FBAV|Line\//.test(ua);
  return /wv\)|; wv|Instagram|FBAN|FBAV/.test(ua);
}

export function homeScreenDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === "done";
  } catch {
    return false;
  }
}

export function markHomeScreenDone(): void {
  try {
    localStorage.setItem(DONE_KEY, "done");
  } catch {
    /* ignore */
  }
}

/** Whether the step has anything to offer this reader right now. */
export function shouldShowHomeScreenStep(): boolean {
  if (homeScreenDone() || isStandalone()) return false;
  return platform() !== "desktop";
}
