"use client";

import { useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { CalendarIcon, NoteIcon } from "@/components/ui/Icons";
import styles from "./MakerSheet.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

/** Where the call is booked. The source tag is how a booking from Aloud is
 *  told apart from one that came from anywhere else. */
const CALL_URL = "https://cal.com/ronak-toprani-0zwtge/15min";
/** Discussions, not an address: this repository is public, and a note left
 *  here is one the next reader can read and answer too. */
const NOTE_URL = "https://github.com/RonakToprani/Aloud/discussions";

/**
 * Cal.com prefills its own booking form from the query string, so the answers
 * ride along and nothing here needs an endpoint, a table or an account:
 * `name` fills its name field and `notes` fills the notes box its form
 * already shows. That is why these are asked here rather than added as
 * questions on the booking page, where they would be a second form after
 * this one.
 */
function bookingUrl(name: string, occupation: string, phone: string): string {
  const notes = [
    occupation.trim() && `What they do: ${occupation.trim()}`,
    phone.trim() && `Phone: ${phone.trim()}`,
    "Booked from Aloud",
  ]
    .filter(Boolean)
    .join("\n");
  const params = new URLSearchParams({ utm_source: "aloud", name: name.trim(), notes });
  return `${CALL_URL}?${params.toString()}`;
}

/** Two ways to reach the team behind Aloud. Opened from the quiet line at the
 *  foot of the library, never on its own. Written in the plural and with no
 *  claim about what Aloud will cost later: institutions are the buyer, and
 *  neither a solo byline nor a promise of "free forever" survives that. */
export function MakerSheet({ open, onClose }: Props) {
  const [booking, setBooking] = useState(false);
  const [name, setName] = useState("");
  const [occupation, setOccupation] = useState("");
  const [phone, setPhone] = useState("");

  // Closing forgets everything typed. Nothing here is stored or sent anywhere
  // but the booking page the reader chooses to open.
  const close = () => {
    setBooking(false);
    setName("");
    setOccupation("");
    setPhone("");
    onClose();
  };

  // A phone number is the one a reader is most likely to baulk at, and a
  // booking is worth more than a phone number, so it stays optional.
  const ready = name.trim().length > 0 && occupation.trim().length > 0;

  return (
    <Sheet open={open} title={booking ? "Before we meet" : "Tell us how it's going"} onClose={close}>
      {booking ? (
        <>
          <p className={styles.note}>
            Three quick things, so the call starts somewhere useful. They go with
            you to the booking page and are not kept here.
          </p>
          <div className={styles.fields}>
            <label className={styles.field}>
              <span className={styles.label}>Your name</span>
              <input
                className={styles.input}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                placeholder="Jane Okafor"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>What you do</span>
              <input
                className={styles.input}
                value={occupation}
                onChange={(e) => setOccupation(e.target.value)}
                autoComplete="organization-title"
                placeholder="Student, teacher, librarian"
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>Phone, if you like</span>
              <input
                className={styles.input}
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                placeholder="Optional"
              />
            </label>
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.back} onClick={() => setBooking(false)}>
              Back
            </button>
            <a
              className={styles.go}
              href={ready ? bookingUrl(name, occupation, phone) : undefined}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={ready ? undefined : true}
              onClick={(e) => {
                if (!ready) e.preventDefault();
              }}
            >
              Pick a time
            </a>
          </div>
        </>
      ) : (
        <>
          <p className={styles.note}>
            We&rsquo;d like to hear how Aloud is working for you, and what it&rsquo;s
            missing. A short call or a written note, either is welcome.
          </p>
          <div className={styles.list}>
            <button type="button" className={styles.option} onClick={() => setBooking(true)}>
              <span className={styles.icon}>
                <CalendarIcon size={18} />
              </span>
              <span className={styles.text}>
                <span className={styles.title}>Book 15 minutes</span>
                <span className={styles.hint}>Pick a time that suits you</span>
              </span>
            </button>
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
        </>
      )}
    </Sheet>
  );
}
