import { EdgeSpeechEngine } from "./edge/engine";
import type {
  PreparedSentence, EngineVoice, SpeakCallbacks, SpeakOptions, SpeechEngine, UtteranceHandle } from "./engine";
import { WebSpeechEngine } from "./webSpeechEngine";

const EDGE_PREFIX = "edge:";

/**
 * Combines the on-device Web Speech engine with Microsoft's cloud voices
 * behind one `SpeechEngine`, so everything above this file — the player, the
 * synchronizer, the voice picker — keeps working unmodified. A voice's id
 * says which engine owns it (`edge:` for a cloud voice); everything else
 * (pause/resume/cancel/isSpeaking/isPaused) is delegated to both, since an
 * idle engine's version of each is already a safe no-op.
 */
export class MultiSpeechEngine implements SpeechEngine {
  readonly id = "multi";
  // Mixed: web voices carry no timings, Edge voices do. Nothing currently
  // reads this flag — the synchronizer decides per utterance from observed
  // boundary events instead.
  readonly providesWordTimings = false;

  constructor(
    private readonly webEngine: WebSpeechEngine,
    private readonly edgeEngine: EdgeSpeechEngine,
  ) {}

  get supported(): boolean {
    return this.webEngine.supported || this.edgeEngine.supported;
  }

  async ready(): Promise<void> {
    await Promise.all([this.webEngine.ready(), this.edgeEngine.ready()]);
  }

  listVoices(): EngineVoice[] {
    return [...this.webEngine.listVoices(), ...this.edgeEngine.listVoices()];
  }

  subscribeVoices(listener: (voices: EngineVoice[]) => void): () => void {
    const emit = () => listener(this.listVoices());
    const unsubscribeWeb = this.webEngine.subscribeVoices(emit);
    const unsubscribeEdge = this.edgeEngine.subscribeVoices(emit);
    return () => {
      unsubscribeWeb();
      unsubscribeEdge();
    };
  }

  unlock(): void {
    this.webEngine.unlock();
    this.edgeEngine.unlock();
  }

  prepare(sentences: PreparedSentence[], options: Omit<SpeakOptions, "text">): void {
    // Only the cloud engine can synthesise sentences together; the device
    // voices speak whatever they are handed, one utterance at a time.
    if (options.voiceId?.startsWith(EDGE_PREFIX)) this.edgeEngine.prepare(sentences, options);
  }

  prefetch(options: SpeakOptions): void {
    if (options.voiceId?.startsWith(EDGE_PREFIX)) this.edgeEngine.prefetch(options);
  }

  speak(options: SpeakOptions, callbacks: SpeakCallbacks): UtteranceHandle {
    if (options.voiceId?.startsWith(EDGE_PREFIX)) {
      return this.edgeEngine.speak(options, callbacks);
    }
    return this.webEngine.speak(options, callbacks);
  }

  pause(): void {
    this.webEngine.pause();
    this.edgeEngine.pause();
  }

  resume(): void {
    this.webEngine.resume();
    this.edgeEngine.resume();
  }

  cancel(): void {
    this.webEngine.cancel();
    this.edgeEngine.cancel();
  }

  isSpeaking(): boolean {
    return this.webEngine.isSpeaking() || this.edgeEngine.isSpeaking();
  }

  isPaused(): boolean {
    return this.webEngine.isPaused() || this.edgeEngine.isPaused();
  }

  destroy(): void {
    this.webEngine.destroy();
    this.edgeEngine.destroy();
  }
}

let singleton: MultiSpeechEngine | null = null;

export function getSpeechEngine(): MultiSpeechEngine {
  if (!singleton) {
    const localePrefix =
      typeof navigator !== "undefined" ? `${navigator.language.split("-")[0]}-` : "en-";
    singleton = new MultiSpeechEngine(new WebSpeechEngine(), new EdgeSpeechEngine({ localePrefix }));
  }
  return singleton;
}
