/**
 * Grouping sentences into one synthesis request.
 *
 * A sentence sent on its own comes back with a full terminal fall and a fresh
 * starting pitch, because the model cannot know anything follows. Several
 * sentences sent together come back as one continuous reading, with the
 * intonation shaped across the whole thing — which is the difference between
 * prose and a list of statements.
 */

/** Where one sentence sits inside the passage that was synthesised. */
export interface PassageSentence {
  /** The exact text the player will pass to speak(). */
  text: string;
  /** Character range within the passage. */
  start: number;
  end: number;
}

export interface PassagePlan {
  /** What gets sent for synthesis. */
  text: string;
  sentences: PassageSentence[];
}

/** Sentences are joined by a single space; the source text already carries its
 *  own punctuation, which is what the model reads the pauses from. */
const JOINER = " ";

/**
 * Long enough that a passage covers a paragraph or so, short enough that the
 * first one does not keep the reader waiting: synthesis time scales with the
 * text, and nothing plays until the whole passage comes back.
 */
export const PASSAGE_MAX_CHARS = 700;

/** The opening passage is deliberately small so pressing play feels immediate;
 *  every later one is synthesised while the previous is still playing. */
export const FIRST_PASSAGE_MAX_CHARS = 220;

export function planPassage(texts: string[], maxChars: number): PassagePlan | null {
  const sentences: PassageSentence[] = [];
  let text = "";

  for (const raw of texts) {
    const sentence = raw.trim();
    if (!sentence) continue;
    const start = text.length ? text.length + JOINER.length : 0;
    const next = text.length ? text + JOINER + sentence : sentence;
    // Always take the first sentence, however long: a passage of nothing is
    // worse than a passage that overshoots.
    if (sentences.length && next.length > maxChars) break;
    text = next;
    sentences.push({ text: sentence, start, end: start + sentence.length });
  }

  return sentences.length ? { text, sentences } : null;
}
