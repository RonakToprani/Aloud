import { Logo } from "./Logo";
import styles from "./SiteFooter.module.css";

/** Forwarded to a person; see "Inbound mail" in CLAUDE.md. */
const CONTACT_EMAIL = "hello@aloudreader.org";

/**
 * The foot of the library and browse pages: the wordmark, the copyright
 * line with the address to write to, and a quiet credit. The reader has no
 * footer; nothing sits below a book.
 */
export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <Logo size={18} />
      <p className={styles.line}>
        &copy; {new Date().getFullYear()} Aloud
        <span className={styles.dot} aria-hidden="true">
          &middot;
        </span>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </p>
      <p className={styles.credit}>
        Built by{" "}
        <a href="https://ronakto.com" target="_blank" rel="noreferrer">
          ronakto.com
        </a>
      </p>
    </footer>
  );
}
