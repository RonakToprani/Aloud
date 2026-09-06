/**
 * A one-shot request to start reading as soon as a book opens.
 *
 * Set when the reader taps the sample on the landing page, and taken by the
 * reader when it loads. It lives in sessionStorage rather than the URL so a
 * refresh doesn't start playback a second time, and it survives the client
 * navigation between the two screens.
 *
 * Kept in its own module, with no imports: the reader would otherwise pull
 * the whole EPUB parser in behind it.
 */
const AUTOPLAY_KEY = "aloud.autoplay";

export function requestAutoplay(bookId: string): void {
  try {
    sessionStorage.setItem(AUTOPLAY_KEY, bookId);
  } catch {
    /* the reader just presses play instead */
  }
}

/** Whether a request is waiting for this book, without spending it. */
export function peekAutoplay(bookId: string): boolean {
  try {
    return sessionStorage.getItem(AUTOPLAY_KEY) === bookId;
  } catch {
    return false;
  }
}

/**
 * True once, and only for the book that asked. Spent on any read, matching
 * or not: a request left behind by a trip that never arrived would otherwise
 * sit there and start playback the next time that book was opened on purpose.
 */
export function takeAutoplay(bookId: string): boolean {
  try {
    const waiting = sessionStorage.getItem(AUTOPLAY_KEY);
    if (waiting !== null) sessionStorage.removeItem(AUTOPLAY_KEY);
    return waiting === bookId;
  } catch {
    return false;
  }
}
