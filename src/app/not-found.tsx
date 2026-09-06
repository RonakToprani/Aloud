import Link from "next/link";
import styles from "@/components/reader/ReaderView.module.css";

export default function NotFound() {
  return (
    <main className={styles.centered}>
      <div className={styles.notice}>
        <h1 className={styles.noticeTitle}>There&rsquo;s nothing here</h1>
        <p className={styles.noticeBody}>That page doesn&rsquo;t exist, or it moved. Your books are where you left them.</p>
        <Link className={styles.noticeAction} href="/">
          Back to your library
        </Link>
      </div>
    </main>
  );
}
