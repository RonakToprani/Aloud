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

/** Two ways to reach the team behind Aloud. Opened from the quiet line at the
 *  foot of the library, never on its own. Written in the plural and with no
 *  claim about what Aloud will cost later: institutions are the buyer, and
 *  neither a solo byline nor a promise of "free forever" survives that. */
export function MakerSheet({ open, onClose }: Props) {
  return (
    <Sheet open={open} title="Tell us how it's going" onClose={onClose}>
      <p className={styles.note}>
        We&rsquo;d like to hear how Aloud is working for you, and what it&rsquo;s
        missing. A short call or a written note, either is welcome.
      </p>
      <div className={styles.list}>
        <a className={styles.option} href={CALL_URL} target="_blank" rel="noopener noreferrer">
          <span className={styles.icon}>
            <CalendarIcon size={18} />
          </span>
          <span className={styles.text}>
            <span className={styles.title}>Book 15 minutes</span>
            <span className={styles.hint}>Pick a time that suits you</span>
          </span>
        </a>
        <a className={styles.option} href={NOTE_URL} target="_blank" rel="noopener noreferrer">
          <span className={styles.icon}>
            <NoteIcon size={18} />
          </span>
          <span className={styles.text}>
            <span className={styles.title}>Send a note</span>
            <span className={styles.hint}>A public page where we read and reply</span>
          </span>
        </a>
      </div>
    </Sheet>
  );
}
