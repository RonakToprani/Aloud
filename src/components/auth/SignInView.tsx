"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { AppleIcon, BackIcon, CheckIcon, FacebookIcon, GoogleIcon, XIcon } from "@/components/ui/Icons";
import type { OAuthProviderId } from "@/components/AuthProvider";
import { hasHadAccount } from "@/lib/storage/prefs";
import styles from "./SignIn.module.css";

/** How long before the link can be sent again. */
const RESEND_SECONDS = 45;
/** The six-digit code only exists once the project's magic-link email
 *  template includes it, which needs a custom SMTP provider. Until then the
 *  screen must not ask for something the email doesn't carry. */
const EMAIL_HAS_CODE = process.env.NEXT_PUBLIC_SUPABASE_EMAIL_CODE === "true";
/** OAuth providers switched on in the Supabase project, e.g. "google,apple".
 *  A button for a provider that isn't configured can only fail, so none are
 *  shown until they are. */
const PROVIDERS = new Set(
  (process.env.NEXT_PUBLIC_AUTH_PROVIDERS ?? "")
    .split(",")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean),
);
interface OAuthOption {
  id: OAuthProviderId;
  label: string;
  Icon: typeof GoogleIcon;
}

/** In the order they are offered. One tap on a provider is the front door;
 *  email is the side door, for people who would rather not link a social
 *  account to what they read. */
const ALL_OAUTH: OAuthOption[] = [
  { id: "google", label: "Continue with Google", Icon: GoogleIcon },
  { id: "facebook", label: "Continue with Facebook", Icon: FacebookIcon },
  { id: "twitter", label: "Continue with X", Icon: XIcon },
  { id: "apple", label: "Continue with Apple", Icon: AppleIcon },
];
const OAUTH = ALL_OAUTH.filter((entry) => PROVIDERS.has(entry.id));

function validEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Sign in is the only thing an account is for — reading works without one —
 * so this screen sells nothing and asks for one thing. Magic link first:
 * one-handed on a phone at night, a password is the worst part of any flow.
 */
export function SignInView() {
  const router = useRouter();
  const { status, email: signedInEmail, sendLink, verifyCode, signInWith } = useAuth();

  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  /** Someone who has signed in on this device before is coming back to
   *  something; everyone else is being offered it for the first time. */
  const [returning, setReturning] = useState(false);
  /** Email is the side door: shown on request, so three provider buttons
   *  and a form do not compete on one screen. */
  const [emailOpen, setEmailOpen] = useState(false);
  const showEmail = OAUTH.length === 0 || emailOpen;

  useEffect(() => {
    setReturning(hasHadAccount());
  }, []);

  useEffect(() => {
    if (status === "signed-in") router.replace("/signin/done");
  }, [status, router]);

  useEffect(() => {
    if (!countdown) return;
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const send = useCallback(
    async (to: string) => {
      setBusy(true);
      setError(null);
      const { error: failure } = await sendLink(to.trim());
      setBusy(false);
      if (failure) {
        setError(failure);
        return;
      }
      setSentTo(to.trim());
      setCountdown(RESEND_SECONDS);
    },
    [sendLink],
  );

  const verify = useCallback(async () => {
    if (!sentTo) return;
    setBusy(true);
    setError(null);
    const { error: failure } = await verifyCode(sentTo, code);
    setBusy(false);
    if (failure) setError(failure);
    // Success arrives through the auth state and the effect above.
  }, [sentTo, code, verifyCode]);

  const oauth = useCallback(
    async (provider: OAuthProviderId) => {
      setError(null);
      const { error: failure } = await signInWith(provider);
      if (failure) setError(failure);
    },
    [signInWith],
  );

  if (status === "unavailable") {
    return (
      <main className={styles.page}>
        <Link href="/" className={styles.back} aria-label="Back">
          <BackIcon size={24} />
        </Link>
        <div className={styles.body}>
          <div className={styles.heading}>
            <h1 className={styles.title}>Accounts are off</h1>
            <p className={styles.subtitle}>
              This copy of Aloud isn&rsquo;t connected to a server, so there&rsquo;s nothing to
              sign in to. Everything still works on this device.
            </p>
          </div>
        </div>
        <p className={styles.footnote}>Books stay yours. We store your progress, not your files.</p>
      </main>
    );
  }

  if (status === "signed-in") {
    return (
      <main className={styles.page}>
        <div className={styles.body}>
          <p className={styles.quiet}>Signed in as {signedInEmail}.</p>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <Link href="/" className={styles.back} aria-label="Back to library">
        <BackIcon size={24} />
      </Link>

      {sentTo ? (
        <div className={styles.body}>
          <div className={styles.sent}>
            <span className={styles.check} aria-hidden="true">
              <CheckIcon size={22} />
            </span>
            <h1 className={styles.sentTitle}>Check your mail</h1>
            <p className={styles.sentBody}>
              We sent a link to <strong>{sentTo}</strong>. It works once, and expires in an
              hour.
            </p>
            <button
              type="button"
              className={styles.resend}
              disabled={countdown > 0 || busy}
              onClick={() => void send(sentTo)}
            >
              {countdown > 0 ? `Send again in ${formatCountdown(countdown)}` : "Send again"}
            </button>
          </div>

          {/* A link opened from a mail app lands in Safari, not in a copy of
              Aloud saved to the home screen. The code in the same email gets
              that reader in without leaving the app. */}
          {EMAIL_HAS_CODE && (
          <form
            className={styles.codeBlock}
            onSubmit={(event) => {
              event.preventDefault();
              void verify();
            }}
          >
            <span className={styles.codeLabel}>
              Reading this on the home-screen app? Type the code from the email instead.
            </span>
            <input
              className={styles.codeInput}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={8}
              placeholder="123456"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              aria-label="Sign-in code"
            />
            <button type="submit" className={styles.primary} disabled={busy || code.length < 6}>
              Continue
            </button>
            {error && <p className={styles.error} role="alert">{error}</p>}
          </form>
          )}
          {!EMAIL_HAS_CODE && error && <p className={styles.error} role="alert">{error}</p>}
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.heading}>
            <h1 className={styles.title}>{returning ? "Welcome back" : "Keep your place"}</h1>
            <p className={styles.subtitle}>
              {returning
                ? "Your library and your place in it, on every device."
                : "Your books and your place in them, on every device you read from."}
            </p>
          </div>

          {OAUTH.length > 0 && (
            <div className={styles.providers}>
              {OAUTH.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className={styles.outlined}
                  onClick={() => void oauth(id)}
                  disabled={busy}
                >
                  <Icon size={16} />
                  {label}
                </button>
              ))}
              <p className={styles.caption}>One tap, no password. Your books stay yours either way.</p>
            </div>
          )}

          {OAUTH.length > 0 && !emailOpen && (
            <button type="button" className={styles.skip} onClick={() => setEmailOpen(true)}>
              Use email instead
            </button>
          )}

          {showEmail && (
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              if (validEmail(email)) void send(email);
            }}
          >
            <input
              className={styles.input}
              type="email"
              inputMode="email"
              autoComplete="email"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-label="Email address"
            />
            <button type="submit" className={styles.primary} disabled={busy || !validEmail(email)}>
              {busy ? "Sending…" : "Email me a link"}
            </button>
            <p className={styles.caption}>
              {returning
                ? "No password. We send a one-time link that signs you in."
                : "No password to make up. We send a one-time link, and that is your account."}
            </p>
          </form>
          )}
          {error && <p className={styles.error} role="alert">{error}</p>}
        </div>
      )}

      <p className={styles.footnote}>Books stay yours. We store your progress, not your files.</p>
    </main>
  );
}
