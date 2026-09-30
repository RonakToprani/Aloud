"use client";

import { Sheet } from "@/components/ui/Sheet";
import { CalendarIcon, NoteIcon } from "@/components/ui/Icons";
import styles from "./MakerSheet.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Where the call is booked. The source tag is how a booking from Aloud is
 *  told apart from one that came from anywhere else. */
const CALL_URL = "https://cal.com/ronak-toprani-0zwtge/15min?utm_source=aloud";
/** Discussions, not an address: this repository is public, and a note left
 *  here is one the next reader can read and answer too. */
const NOTE_URL = "https://github.com/RonakToprani/Aloud/discussions";

/** Two ways to reach the person who makes Aloud. Opened from the quiet line
 *  at the foot of the library, never on its own. */
export function MakerSheet({ open, onClose }: Props) {
  return (
    <Sheet open={open} title="Say hello" onClose={onClose}>
      <p className={styles.note}>
        I&rsquo;m building Aloud on my own, and I&rsquo;d like to hear how it&rsquo;s going for
        you. A short call or a written note, whichever suits you.
      </p>
      <div className={styles.list}>
        <a className={styles.option} href={CALL_URL} target="_blank" rel="noopener noreferrer">
          <span className={styles.icon}>
            <CalendarIcon size={18} />
          </span>
          <span className={styles.text}>
            <span className={styles.title}>Book 15 minutes with me</span>
            <span className={styles.hint}>Pick a time that suits you</span>
          </span>
        </a>
        <a className={styles.option} href={NOTE_URL} target="_blank" rel="noopener noreferrer">
          <span className={styles.icon}>
            <NoteIcon size={18} />
          </span>
          <span className={styles.text}>
            <span className={styles.title}>Send me a note</span>
            <span className={styles.hint}>A public page where I read and reply</span>
          </span>
        </a>
      </div>
    </Sheet>
  );
}
