/**
 * The offline voices this page can offer, one source per model, created
 * once: a model is far too large to load twice. Which models are offered is
 * each adapter's call (Kokoro declines WebKit); which voice is the default
 * offline voice is decided here, best first.
 */

import { KokoroAdapter } from "../kokoro/adapter";
import { PiperAdapter } from "../piper/adapter";
import { OfflineModelSource } from "./source";

let sources: OfflineModelSource[] | null = null;

export function getOfflineSources(): OfflineModelSource[] {
  if (!sources) sources = [new OfflineModelSource(new KokoroAdapter()), new OfflineModelSource(new PiperAdapter())];
  return sources;
}

/** The source whose voice this is, or null for a device or cloud voice. */
export function offlineSourceFor(voiceId: string | null | undefined): OfflineModelSource | null {
  if (!voiceId) return null;
  return getOfflineSources().find((source) => voiceId.startsWith(source.prefix)) ?? null;
}

export function isOfflineVoice(voiceId: string | null | undefined): boolean {
  return offlineSourceFor(voiceId) !== null;
}

/** The bare voice id a source understands: the prefix removed. */
export function bareVoice(voiceId: string): string {
  const source = offlineSourceFor(voiceId);
  return source ? voiceId.slice(source.prefix.length) : voiceId;
}

/** The offline voice to prefer when none is chosen: the first voice of the
 *  first model this browser supports, which is the best-sounding one that
 *  will actually run here. */
export function defaultOfflineVoiceId(): string | null {
  for (const source of getOfflineSources()) {
    const voice = source.supported() ? source.listVoicesSync()[0] : undefined;
    if (voice) return voice.id;
  }
  return null;
}
