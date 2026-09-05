"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** True when the project has been pointed at a Supabase instance. Without
 *  it the app runs exactly as before: local-only, no account. */
export const supabaseConfigured = Boolean(url && anonKey);

let client: SupabaseClient | null = null;
let accessToken: string | null = null;

/** The browser client, created once. Null on the server or when unconfigured. */
export function getSupabase(): SupabaseClient | null {
  if (!supabaseConfigured || typeof window === "undefined") return null;
  if (client) return client;
  client = createClient(url!, anonKey!, {
    auth: {
      // The implicit flow puts the session in the link itself, so a magic
      // link works in whichever browser opens it — a PWA on iOS hands mail
      // links to Safari, which has no PKCE verifier to exchange.
      flowType: "implicit",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  client.auth.onAuthStateChange((_event, session) => {
    accessToken = session?.access_token ?? null;
  });
  void client.auth.getSession().then(({ data }) => {
    accessToken = data.session?.access_token ?? null;
  });
  return client;
}

/**
 * A REST upsert that survives the page closing. supabase-js requests are
 * dropped by the browser during `pagehide`; a `keepalive` fetch is not.
 * Used for the writes that matter most: the exact word on leaving, and the
 * seconds listened.
 */
export function keepaliveUpsert(table: string, rows: Record<string, unknown>[]): void {
  if (!supabaseConfigured || !accessToken || typeof fetch === "undefined") return;
  try {
    void fetch(`${url}/rest/v1/${table}`, {
      method: "POST",
      keepalive: true,
      headers: {
        apikey: anonKey!,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    }).catch(() => {});
  } catch {
    /* nothing to do: the next regular write will carry the same data */
  }
}
