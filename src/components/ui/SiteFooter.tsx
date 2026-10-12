import { Logo } from "./Logo";
import styles from "./SiteFooter.module.css";

/** Shown only when an inbox exists to answer it: a mailto to an address
 *  nobody reads is worse than no address, since the reply bounces. */
const CONTACT_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL;

/**
 * The foot of the library and browse pages: the wordmark, who built it, and
 * a way to write in. The reader has no footer; nothing sits below a book.
 */
export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <Logo size={18} />
      <p className={styles.line}>
        &copy; {new Date().getFullYear()}. Built by{" "}
        <a href="https://ronakto.com" target="_blank" rel="noreferrer">
          ronakto.com
        </a>
        {CONTACT_EMAIL && (
          <>
            <span className={styles.dot} aria-hidden="true">
              &middot;
            </span>
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </>
        )}
      </p>
    </footer>
  );
}
