"use client";

import { useEffect, useState } from "react";

/** Whether the browser believes it has a connection. Optimistic on the
 *  server and before mount, so nothing is painted as offline that is not. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}
