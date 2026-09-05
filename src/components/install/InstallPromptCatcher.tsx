"use client";

import { useEffect } from "react";
import { catchInstallPrompt } from "./installPrompt";

/** Mounted once at the root so Chrome's install prompt is caught before the
 *  home-screen step needs it. Renders nothing. */
export function InstallPromptCatcher() {
  useEffect(() => {
    catchInstallPrompt();
  }, []);
  return null;
}
