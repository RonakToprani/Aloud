import { EdgeSpeechEngine } from "./edge/engine";
import type {
  PreparedSentence, EngineVoice, SpeakCallbacks, SpeakOptions, SpeechEngine, UtteranceHandle } from "./engine";
import { getOfflineSources } from "./offline/registry";
import { PassageSpeechEngine } from "./passageEngine";
import { WebSpeechEngine } from "./webSpeechEngine";

const EDGE_PREFIX = "edge:";

/**
 * Combines the on-device Web Speech engine, Microsoft's cloud voices and the
 * offline model behind one `SpeechEngine`, so everything above this file —
 * the player, the synchronizer, the voice picker — keeps working unmodified.
 * A voice's id says which engine owns it (`edge:` for a cloud voice,
 * `kokoro:` or `piper:` for an offline model); everything else
 * (pause/resume/cancel/isSpeaking/isPaused) is delegated to all of them,
 * since an idle engine's version of each is already a safe no-op.
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
    /** One per offline model, each answering to its own voice prefix. */
    private readonly offlineEngines: PassageSpeechEngine[],
  ) {}

  private get all(): SpeechEngine[] {
    return [this.webEngine, this.edgeEngine, ...this.offlineEngines];
  }

  /** The engine that synthesises passages for this voice, if any. */
  private passageEngineFor(voiceId: string | null | undefined): PassageSpeechEngine | null {
    if (!voiceId) return null;
    if (voiceId.startsWith(EDGE_PREFIX)) return this.edgeEngine;
    return this.offlineEngines.find((engine) => voiceId.startsWith(engine.prefix)) ?? null;
  }

  get supported(): boolean {
    return this.all.some((engine) => engine.supported);
  }

  async ready(): Promise<void> {
    await Promise.all(this.all.map((engine) => engine.ready()));
  }

  listVoices(): EngineVoice[] {
    return this.all.flatMap((engine) => engine.listVoices());
  }

  subscribeVoices(listener: (voices: EngineVoice[]) => void): () => void {
    const emit = () => listener(this.listVoices());
    const unsubscribes = this.all.map((engine) => engine.subscribeVoices(emit));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }

  unlock(): void {
    for (const engine of this.all) engine.unlock();
  }

  /** The most any engine wants to see ahead; the others ignore the rest. */
  get lookahead(): number | undefined {
    return this.all.reduce<number | undefined>(
      (most, engine) => (engine.lookahead !== undefined && (most === undefined || engine.lookahead > most) ? engine.lookahead : most),
      undefined,
    );
  }

  startBudgetMs(voiceId: string | null): number | undefined {
    return this.passageEngineFor(voiceId)?.startBudgetMs(voiceId);
  }

  prepare(sentences: PreparedSentence[], options: Omit<SpeakOptions, "text">): void {
    // Only the synthesising engines can take sentences together; the device
    // voices speak whatever they are handed, one utterance at a time.
    this.passageEngineFor(options.voiceId)?.prepare(sentences, options);
  }

  prefetch(options: SpeakOptions): void {
    this.passageEngineFor(options.voiceId)?.prefetch(options);
  }

  speak(options: SpeakOptions, callbacks: SpeakCallbacks): UtteranceHandle {
    return (this.passageEngineFor(options.voiceId) ?? this.webEngine).speak(options, callbacks);
  }

  pause(): void {
    for (const engine of this.all) engine.pause();
  }

  resume(): void {
    for (const engine of this.all) engine.resume();
  }

  cancel(): void {
    for (const engine of this.all) engine.cancel();
  }

  isSpeaking(): boolean {
    return this.all.some((engine) => engine.isSpeaking());
  }

  isPaused(): boolean {
    return this.all.some((engine) => engine.isPaused());
  }

  destroy(): void {
    for (const engine of this.all) engine.destroy();
  }
}

let singleton: MultiSpeechEngine | null = null;

export function getSpeechEngine(): MultiSpeechEngine {
  if (!singleton) {
    const localePrefix =
      typeof navigator !== "undefined" ? `${navigator.language.split("-")[0]}-` : "en-";
    singleton = new MultiSpeechEngine(
      new WebSpeechEngine(),
      new EdgeSpeechEngine({ localePrefix }),
      getOfflineSources().map((source) => new PassageSpeechEngine(source)),
    );
  }
  return singleton;
}
