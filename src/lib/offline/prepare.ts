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
import { bareVoice, defaultOfflineVoiceId, isOfflineVoice, offlineSourceFor } from "@/lib/speech/offline/registry";

/** Which offline voice a chapter is prepared in: the one chosen, if it is
 *  one, else the best this browser can run. */
export function offlineVoiceFor(voiceId: string | null): string | null {
  return isOfflineVoice(voiceId) && voiceId ? voiceId : defaultOfflineVoiceId();
}

export function prepareChapterOffline(chapter: SegmentedChapter, voiceId: string | null, rate: number): void {
  const voice = offlineVoiceFor(voiceId);
  const source = offlineSourceFor(voice);
  if (!voice || !source) return;
  // The exact strings the player will hand to speak(): a clip is found by
  // its text, so anything else would be rendered and never used.
  const texts = chapter.sentences.map((sentence) => sentence.speakable).filter((text) => text.trim());
  source.prepareAll(texts, bareVoice(voice), rate);
}

export function stopPreparingOffline(voiceId: string | null): void {
  offlineSourceFor(offlineVoiceFor(voiceId))?.stopPreparing();
}
