"use client";

import { useState } from "react";
import { CURRENT, RENEWALS, ROLES } from "@/lib/education/interest";
import styles from "./Education.module.css";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

export function InterestForm() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(event.currentTarget).entries());
    setState({ kind: "sending" });
    try {
      const response = await fetch("/api/education/interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const answer = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(answer.error || "Something went wrong. Please try again.");
      setState({ kind: "sent" });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "Something went wrong." });
    }
  }

  if (state.kind === "sent") {
    return (
      <div className={styles.thanks} role="status">
        <p className={styles.thanksTitle}>Thank you. Your course is in line.</p>
        <p>We will write within one business day to tell you where to send the readings.</p>
      </div>
    );
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate={false}>
      <div className={styles.row}>
        <label className={styles.field}>
          <span>Your name</span>
          <input name="name" autoComplete="name" required maxLength={120} />
        </label>
        <label className={styles.field}>
          <span>Work email</span>
          <input name="email" type="email" autoComplete="email" required maxLength={254} />
        </label>
      </div>
      <label className={styles.field}>
        <span>School or institution</span>
        <input name="institution" autoComplete="organization" required maxLength={200} />
      </label>
      <div className={styles.row}>
        <label className={styles.field}>
          <span>Your role</span>
          <select name="role" required defaultValue="">
            <option value="" disabled>
              Choose one
            </option>
            {ROLES.map((role) => (
              <option key={role}>{role}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>
            What do students use today? <span className={styles.optional}>(optional)</span>
          </span>
          <select name="current" defaultValue="">
            <option value="">Choose one</option>
            {CURRENT.map((tool) => (
              <option key={tool}>{tool}</option>
            ))}
          </select>
        </label>
      </div>
      <label className={styles.field}>
        <span>
          When does that licence renew? <span className={styles.optional}>(optional)</span>
        </span>
        <select name="renewal" defaultValue="">
          <option value="">Choose one</option>
          {RENEWALS.map((when) => (
            <option key={when}>{when}</option>
          ))}
        </select>
      </label>
      <label className={styles.field}>
        <span>
          Which course should we do first? <span className={styles.optional}>(optional)</span>
        </span>
        <textarea
          name="message"
          rows={4}
          maxLength={2000}
          placeholder="The course, roughly how many readings, and whether any are scans"
        />
      </label>
      {/* Hidden from people and from screen readers; only a bot fills it. */}
      <label className={styles.trap} aria-hidden="true">
        Website
        <input name="website" tabIndex={-1} autoComplete="off" />
      </label>
      <div className={styles.submitRow}>
        <button className={styles.primary} type="submit" disabled={state.kind === "sending"}>
          {state.kind === "sending" ? "Sending" : "Claim your free course"}
        </button>
        <p className={styles.fine}>We will only use this to write to you about your course and Aloud.</p>
      </div>
      {state.kind === "error" && (
        <p className={styles.error} role="alert">
          {state.message}
        </p>
      )}
    </form>
  );
}
