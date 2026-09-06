import { importPastedText } from "./import";
import type { BookMeta } from "@/lib/types";

/**
 * The sample gets an id of its own per device, remembered so that tapping
 * it twice opens the same book rather than stacking copies on the shelf.
 *
 * Deliberately not one fixed id shared by everyone: book ids are global on
 * the account, so a shared id would mean the first person ever to listen
 * owned that row and everyone after them was refused.
 */
const SAMPLE_ID_KEY = "aloud.sampleId.v1";

/** Falls back to this when storage refuses, so a session still settles on
 *  one id rather than shelving a new copy on every tap. */
let sessionSampleId: string | null = null;

function sampleId(): string {
  try {
    const existing = localStorage.getItem(SAMPLE_ID_KEY);
    if (existing) return existing;
  } catch {
    if (sessionSampleId) return sessionSampleId;
  }
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? `sample-${crypto.randomUUID()}`
      : `sample-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  sessionSampleId = id;
  try {
    localStorage.setItem(SAMPLE_ID_KEY, id);
  } catch {
    /* private browsing: the session id above carries it instead */
  }
  return id;
}

export const SAMPLE_TITLE = "Mrs Dalloway";
export const SAMPLE_AUTHOR = "Virginia Woolf";

/**
 * The opening of Mrs Dalloway (1925), which is in the public domain
 * worldwide. Chosen because the sentences vary wildly in length: a
 * five-word line and a sixty-word line back to back is what shows the
 * highlight actually tracking a voice rather than ticking along a metre.
 *
 * Kept to a few hundred words. It is the first thing a visitor hears, and
 * it has to be in front of them before they think about leaving.
 */
export const SAMPLE_TEXT = `Mrs. Dalloway said she would buy the flowers herself.

For Lucy had her work cut out for her. The doors would be taken off their hinges; Rumpelmayer's men were coming. And then, thought Clarissa Dalloway, what a morning—fresh as if issued to children on a beach.

What a lark! What a plunge! For so it had always seemed to her, when, with a little squeak of the hinges, which she could hear now, she had burst open the French windows and plunged at Bourton into the open air. How fresh, how calm, stiller than this of course, the air was in the early morning; like the flap of a wave; the kiss of a wave; chill and sharp and yet solemn, feeling as she did, standing there at the open window, that something awful was about to happen.

She had a perpetual sense, as she watched the taxi cabs, of being out, out, far out to sea and alone; she always had the feeling that it was very, very dangerous to live even one day.`;

/** Adds the sample to the library, or returns to the copy already there. */
export function addSampleBook(): Promise<BookMeta> {
  return importPastedText(SAMPLE_TEXT, SAMPLE_TITLE, undefined, {
    id: sampleId(),
    author: SAMPLE_AUTHOR,
  });
}
