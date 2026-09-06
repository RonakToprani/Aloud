"use client";

import { useEffect } from "react";

/** Registers the service worker that keeps the shell openable offline.
 *  Production only: in development it would cache a page that changes on
 *  every save. Renders nothing. */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);
  return null;
}
