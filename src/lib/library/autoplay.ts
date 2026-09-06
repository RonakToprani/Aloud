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

/** True once, and only for the book that asked. */
export function takeAutoplay(bookId: string): boolean {
  try {
    if (sessionStorage.getItem(AUTOPLAY_KEY) !== bookId) return false;
    sessionStorage.removeItem(AUTOPLAY_KEY);
    return true;
  } catch {
    return false;
  }
}
