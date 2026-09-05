import { escapeSsml, ratePercent } from "./protocol";

/**
 * Builds the SSML for a passage.
 *
 * This runs on the server and derives everything from the text itself. The
 * client never sends SSML: the route is a proxy anyone who finds it can post
 * to, and accepting markup would let a caller drive the synthesiser with
 * arbitrary directives rather than with a book.
 *
 * ## What this endpoint will not do
 *
 * Marking the text up for prosody is the obvious lever and it is not available
 * here. Measured against the live endpoint:
 *
 * - `<break time="..."/>` is **rejected**. Identical text returns 200 without
 *   one and 502 with one — the connection is closed before `turn.end`. This is
 *   Edge's own Read Aloud endpoint and it appears to accept only the shape
 *   Edge itself sends, not SSML generally.
 * - Whitespace carries **no** prosodic weight. A paragraph separated by a
 *   blank line and the same text separated by a single space both produce a
 *   400ms pause — the sentence-final period is doing all of the work.
 *
 * So pauses come from the punctuation already in the prose, and the one place
 * a longer pause can be placed is at a passage boundary, which is why passages
 * are planned to end at paragraph ends (see `planPassage`).
 *
 * The prosody element is kept even at 1x, where its values are no-ops, because
 * it is what Edge sends and this endpoint is fussy about the shape.
 */
export function buildSsml(text: string, voice: string, rate: number): string {
  // Newlines are meaningless to the synthesiser but the passage text carries
  // them as paragraph separators, so collapse them rather than sending them.
  const body = escapeSsml(text.replace(/\s+/g, " ").trim());

  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>` +
    `<prosody pitch='+0Hz' rate='${ratePercent(rate)}' volume='+0%'>${body}</prosody>` +
    `</voice></speak>`
  );
}
