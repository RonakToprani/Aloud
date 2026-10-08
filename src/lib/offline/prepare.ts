/**
 * Preparing a chapter to be read with no connection.
 *
 * On a phone the offline model is slower than speech, so a chapter heard
 * for the first time with no clips in the store pauses between passages
 * while the next one is rendered. Rendering the chapter before leaving the
 * network is what makes it read straight through, and the reader asks for
 * it here, explicitly: rendering is minutes of full CPU and nobody's
 * battery should be spent on it unasked.
 */

import type { SegmentedChapter } from "@/lib/text/segment";
import { getOfflineVoice } from "@/lib/speech/kokoro/source";
import { isKokoroVoice, KOKORO_PREFIX, KOKORO_VOICES } from "@/lib/speech/kokoro/voices";

/** Which offline voice a chapter is prepared in: the one chosen, if it is
 *  one, else the best of them. */
export function offlineVoiceFor(voiceId: string | null): string {
  return isKokoroVoice(voiceId) && voiceId ? voiceId : `${KOKORO_PREFIX}${KOKORO_VOICES[0].id}`;
}

export function prepareChapterOffline(chapter: SegmentedChapter, voiceId: string | null, rate: number): void {
  const voice = offlineVoiceFor(voiceId).slice(KOKORO_PREFIX.length);
  // The exact strings the player will hand to speak(): a clip is found by
  // its text, so anything else would be rendered and never used.
  const texts = chapter.sentences.map((sentence) => sentence.speakable).filter((text) => text.trim());
  getOfflineVoice().prepareAll(texts, voice, rate);
}

export function stopPreparingOffline(): void {
  getOfflineVoice().stopPreparing();
}
