"use client";

import type { Provider, Session, User } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  sendLink: (email: string) => Promise<{ error: string | null }>;
  verifyCode: (email: string, code: string) => Promise<{ error: string | null }>;
  signInWith: (provider: "apple" | "google") => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Where a magic link lands. Absolute, because the mail client opens it cold. */
export function signInRedirect(): string {
  return `${window.location.origin}/signin/done`;
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
      }
      if (!next) {
        setStatus("signed-out");
      } else if (next.user.is_anonymous) {
        setStatus("anonymous");
      } else {
        setStatus("signed-in");
      }
    };

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, next) => apply(next));

    void supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return;
      if (data.session) {
        apply(data.session);
        return;
      }
      // No account yet: make a quiet one so this reader's progress syncs and
      // their listening counts, without asking anything of them. If the
      // project has anonymous sign-ins off, the app simply stays local.
      const { data: anon, error } = await supabase.auth.signInAnonymously();
      if (!alive) return;
      if (error || !anon.session) setStatus("signed-out");
      else apply(anon.session);
    });

    return () => {
      alive = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const sendLink = useCallback(async (email: string) => {
    const supabase = getSupabase();
    if (!supabase) return { error: "Sign-in isn't available in this build." };
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: signInRedirect(), shouldCreateUser: true },
    });
    return { error: describe(error) };
  }, []);

  const verifyCode = useCallback(async (email: string, code: string) => {
    const supabase = getSupabase();
    if (!supabase) return { error: "Sign-in isn't available in this build." };
    const { error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: "email" });
    return { error: describe(error) };
  }, []);

  const signInWith = useCallback(async (provider: "apple" | "google") => {
    const supabase = getSupabase();
    if (!supabase) return { error: "Sign-in isn't available in this build." };
    const { error } = await supabase.auth.signInWithOAuth({
      provider: provider as Provider,
      options: { redirectTo: signInRedirect() },
    });
    return { error: describe(error) };
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    await supabase.auth.signOut();
    // Back to a quiet anonymous account, as on first visit.
    const { data } = await supabase.auth.signInAnonymously();
    if (!data.session) setStatus("signed-out");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: session?.user ?? null,
      userId: session?.user.id ?? null,
      email: session?.user.email ?? null,
      epoch,
      sendLink,
      verifyCode,
      signInWith,
      signOut,
    }),
    [status, session, epoch, sendLink, verifyCode, signInWith, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
