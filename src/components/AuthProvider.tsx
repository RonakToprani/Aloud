"use client";

import type { Provider, Session, User } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { rememberAccount } from "@/lib/storage/prefs";
import { getSupabase, supabaseConfigured } from "@/lib/supabase/client";

export type AuthStatus =
  /** No Supabase project configured: the app is local-only. */
  | "unavailable"
  /** Reading the stored session. */
  | "loading"
  /** A silent anonymous account, so progress and listening time count. */
  | "anonymous"
  /** A real account with an email. */
  | "signed-in"
  /** Configured, but no session at all — anonymous sign-ins are off. */
  | "signed-out";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Convenience: the user id, or null. */
  userId: string | null;
  email: string | null;
  /** Bumps whenever the account changes, so sync work can re-run. */
  epoch: number;
  /** Make sure there is an account to write to, creating a quiet anonymous
   *  one if needed. Called the first time the reader does something worth
   *  keeping, so a visit that only looks around costs nothing. */
  ensureAccount: () => Promise<void>;
  sendLink: (email: string) => Promise<{ error: string | null }>;
  verifyCode: (email: string, code: string) => Promise<{ error: string | null }>;
  signInWith: (provider: OAuthProviderId) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

/** The providers the sign-in screen may offer, by Supabase's names. */
export type OAuthProviderId = "google" | "facebook";

const AuthContext = createContext<AuthContextValue | null>(null);

/** Where a magic link lands. Absolute, because the mail client opens it cold. */
export function signInRedirect(): string {
  return `${window.location.origin}/signin/done`;
}

/** The anonymous account's claim, held while the reader signs in. See
 *  `20261028000000_claim_anonymous.sql`: without it everything done before
 *  signing in stays on an account the reader can never reach again. */
const CLAIM_KEY = "aloud.claim.v1";

function readClaim(): string | null {
  try {
    return localStorage.getItem(CLAIM_KEY);
  } catch {
    return null;
  }
}

function writeClaim(claim: string | null): void {
  try {
    if (claim) localStorage.setItem(CLAIM_KEY, claim);
    else localStorage.removeItem(CLAIM_KEY);
  } catch {
    /* private browsing: the books stay on the anonymous account */
  }
}

/** Taken while still anonymous, before the session is replaced. */
async function prepareClaim(session: Session | null): Promise<void> {
  const supabase = getSupabase();
  if (!supabase || !session?.user.is_anonymous) return;
  const { data, error } = await supabase.rpc("issue_account_claim");
  if (!error && typeof data === "string") writeClaim(data);
}

function describe(error: { message?: string } | null | undefined): string | null {
  if (!error) return null;
  const message = error.message ?? "";
  if (/rate limit|too many/i.test(message)) return "Too many attempts for now. Try again in a minute.";
  if (/invalid|expired|otp/i.test(message)) return "That code didn't match. Check the newest email and try again.";
  if (/provider is not enabled|unsupported provider/i.test(message)) {
    return "That way of signing in isn't switched on yet.";
  }
  if (/network|fetch/i.test(message)) return "Couldn't reach the server. Check your connection and try again.";
  return message || "Something went wrong. Try again.";
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>(supabaseConfigured ? "loading" : "unavailable");
  const [epoch, setEpoch] = useState(0);
  const lastUserId = useRef<string | null>(null);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    let alive = true;

    const apply = (next: Session | null) => {
      if (!alive) return;
      setSession(next);
      const uid = next?.user.id ?? null;
      if (uid !== lastUserId.current) {
        lastUserId.current = uid;
        setEpoch((e) => e + 1);
        const claim = readClaim();
        if (claim && next && !next.user.is_anonymous) {
          const supabase = getSupabase();
          void Promise.resolve(supabase?.rpc("redeem_account_claim", { claim }))
            .then((result) => {
              // A network failure keeps the claim for the next load; an answer,
              // even "nothing to move", spends it.
              if (result && !result.error) writeClaim(null);
              // The books now belong to this account, so sync runs again and
              // finds them.
              if (alive) setEpoch((e) => e + 1);
            })
            .catch(() => {});
        }
      }
      if (!next) {
        setStatus("signed-out");
      } else if (next.user.is_anonymous) {
        setStatus("anonymous");
      } else {
        rememberAccount();
        setStatus("signed-in");
      }
    };

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => apply(next));

    void supabase.auth.getSession().then(({ data }) => {
      if (!alive) return;
      if (data.session) apply(data.session);
      else setStatus("signed-out");
    });

    return () => {
      alive = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const anonInFlight = useRef<Promise<void> | null>(null);
  const ensureAccount = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    if (session) return;
    if (anonInFlight.current) return anonInFlight.current;
    // A quiet account so this reader's progress syncs and their listening
    // counts, without asking anything of them. If the project has anonymous
    // sign-ins off, the app simply stays local.
    anonInFlight.current = supabase.auth
      .signInAnonymously()
      .then(({ data, error }) => {
        if (error || !data.session) setStatus("signed-out");
      })
      .catch(() => {})
      .finally(() => {
        anonInFlight.current = null;
      });
    return anonInFlight.current;
  }, [session]);

  const sendLink = useCallback(async (email: string) => {
    const supabase = getSupabase();
    if (!supabase) return { error: "Sign-in isn't available in this build." };
    await prepareClaim(session).catch(() => {});
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: signInRedirect(), shouldCreateUser: true },
    });
    return { error: describe(error) };
  }, [session]);

  const verifyCode = useCallback(async (email: string, code: string) => {
    const supabase = getSupabase();
    if (!supabase) return { error: "Sign-in isn't available in this build." };
    const { error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: "email" });
    return { error: describe(error) };
  }, []);

  const signInWith = useCallback(async (provider: OAuthProviderId) => {
    const supabase = getSupabase();
    if (!supabase) return { error: "Sign-in isn't available in this build." };
    await prepareClaim(session).catch(() => {});
    const { error } = await supabase.auth.signInWithOAuth({
      provider: provider as Provider,
      options: { redirectTo: signInRedirect() },
    });
    return { error: describe(error) };
  }, [session]);

  const signOut = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    setStatus("signed-out");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: session?.user ?? null,
      userId: session?.user.id ?? null,
      email: session?.user.email ?? null,
      epoch,
      ensureAccount,
      sendLink,
      verifyCode,
      signInWith,
      signOut,
    }),
    [status, session, epoch, ensureAccount, sendLink, verifyCode, signInWith, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
