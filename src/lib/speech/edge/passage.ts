/**
 * Grouping sentences into one synthesis request.
 *
 * A sentence sent on its own comes back with a full terminal fall and a fresh
 * starting pitch, because the model cannot know anything follows. Several
 * sentences sent together come back as one continuous reading, with the
 * intonation shaped across the whole thing — which is the difference between
 * prose and a list of statements.
 */

export interface PassageInput {
  text: string;
  /** True when the next sentence begins a new paragraph. */
  endsParagraph: boolean;
}

/** Where one sentence sits inside the passage that was synthesised. */
export interface PassageSentence {
  /** The exact text the player will pass to speak(). */
  text: string;
  /** Character range within the passage. */
  start: number;
  end: number;
}

export interface PassagePlan {
  /** What gets sent for synthesis. Paragraphs are separated by a blank line,
   *  which is what the server reads to place its longer breaks. */
  text: string;
  sentences: PassageSentence[];
}

const SENTENCE_JOINER = " ";
const PARAGRAPH_JOINER = "\n\n";

/**
 * How much text to synthesise at once. Larger passages give the model more to
 * shape the intonation across, and the next one is requested at the start of
 * the previous, which leaves well over a minute of margin at this size.
 */
export const PASSAGE_MAX_CHARS = 1500;

/** The opening passage is deliberately small so pressing play feels immediate;
 *  every later one is synthesised while the previous is still playing. */
export const FIRST_PASSAGE_MAX_CHARS = 220;

/**
 * Builds the largest passage that fits, ending it at a paragraph break
 * wherever possible.
 *
 * The seam between two passages is the one place a pitch reset is audible, and
 * a paragraph end is where a reset belongs anyway — a reader expects a breath
 * there. Cutting mid-paragraph because a character budget ran out puts the
 * reset in the one place it sounds wrong.
 */
export function planPassage(inputs: PassageInput[], maxChars: number): PassagePlan | null {
  const sentences: Building[] = [];
  let text = "";
  /** Sentence count at the last paragraph end seen inside the budget. */
  let lastParagraphEnd = 0;
  /** Whether the budget stopped us, rather than running out of sentences. */
  let budgetRanOut = false;

  for (const input of inputs) {
    const sentence = input.text.trim();
    if (!sentence) continue;

    const joiner = !text.length
      ? ""
      : sentences[sentences.length - 1]?.endsParagraph
        ? PARAGRAPH_JOINER
        : SENTENCE_JOINER;
    const start = text.length + joiner.length;
    const next = text + joiner + sentence;

    // Always take the first sentence, however long: a passage of nothing is
    // worse than one that overshoots.
    if (sentences.length && next.length > maxChars) {
      budgetRanOut = true;
      break;
    }

    text = next;
    sentences.push({ text: sentence, start, end: start + sentence.length, endsParagraph: input.endsParagraph });
    if (input.endsParagraph) lastParagraphEnd = sentences.length;
  }

  if (!sentences.length) return null;

  // Snapping back to a paragraph end is only worth doing when the budget cut
  // the passage short. Having taken every sentence offered, there is no seam
  // to move — trimming here would drop text that fitted perfectly well.
  if (budgetRanOut && lastParagraphEnd > 0 && lastParagraphEnd < sentences.length) {
    const kept = sentences.slice(0, lastParagraphEnd);
    return { text: text.slice(0, kept[kept.length - 1].end), sentences: kept.map(strip) };
  }
  return { text, sentences: sentences.map(strip) };
}

interface Building extends PassageSentence {
  endsParagraph: boolean;
}

function strip(sentence: PassageSentence): PassageSentence {
  return { text: sentence.text, start: sentence.start, end: sentence.end };
}
