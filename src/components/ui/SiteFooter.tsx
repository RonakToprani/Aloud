import { LogoMark } from "./Logo";
import styles from "./SiteFooter.module.css";

/** Forwarded to a person; see "Inbound mail" in CLAUDE.md. */
const CONTACT_EMAIL = "hello@aloudreader.org";

/**
 * The foot of the library and browse pages, one line: the copyright and the
 * address to write to on the left, the credit on the right. It wraps to two
 * lines on a narrow phone. The reader has no footer; nothing sits below a
 * book.
 */
export function SiteFooter() {
  return (
    <footer className={styles.footer}>
      <p className={styles.line}>
        <LogoMark size={14} className={styles.mark} />
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
