import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { shouldMerge } from "@/lib/text/segment";
import { type EdgeEndpoint, edgeEndpoints, edgeHeaders, synthesisUrl } from "./protocol";
import { buildSsml } from "./ssml";

/** One spoken word, timed against the returned audio. */
export interface TimedWord {
  /** Offset into the text we asked for, so the reader can map it to a word. */
  charIndex: number;
  charLength: number;
  /** Milliseconds from the start of the audio. */
  offsetMs: number;
  durationMs: number;
}

export interface Synthesis {
  audio: Buffer;
  words: TimedWord[];
}

export class EdgeSynthesisError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EdgeSynthesisError";
  }
}

/** Everything a passage may take, retries included, inside the route's sixty
 *  second budget. */
const TIMEOUT_MS = 55_000;
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
/** Edge's MP3 is bare constant-rate frames, no ID3 or Xing header, so a
 *  turn's byte length is its exact duration and turns join end to end. */
const OUTPUT_BYTES_PER_MS = 48_000 / 8 / 1000;

/**
 * How a passage is split across connections.
 *
 * Since the October 2026 host change one connection streams audio at about
 * twice real time where it used to be near instant: measured from Node, 370
 * characters took 12 to 16 s and every 1500 character passage hit the
 * timeout. Connections run side by side at the same rate each (four of 375
 * characters took 20 s together, twelve of 200 took 21 s), so a passage is
 * cut at sentence ends into pieces synthesised at once. The pieces are as
 * small as the parallelism allows, never under one sentence, so the opening
 * passage goes out a sentence per connection and starts in about four seconds,
 * which is what one sentence alone takes now.
 * The join falls in a sentence gap, which `tighten.ts` trims like any other.
 */
const MAX_PARALLEL_TURNS = 6;

/** Edge answers inside a couple of seconds and then streams without pause;
 *  this long with nothing is a socket that died, often a pooled one the far
 *  end dropped without a close, and the piece is retried on a fresh one. */
const STALL_MS = 12_000;
/** A handshake normally takes under a second. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * Connection pooling: the reader prefetches the next sentence while the
 * current one plays, so a connection this call opens is almost always sitting
 * idle again well before the next sentence needs one. Reusing it skips the
 * WebSocket handshake — the dominant cost we measured, roughly as long as
 * synthesis itself — for every sentence after the first. Kept small since
 * only one turn can run on a connection at a time; anything beyond what's
 * idle just opens fresh, exactly like before pooling existed.
 */
const MAX_POOL_SIZE = MAX_PARALLEL_TURNS;
/** Long enough to outlast a slow sentence, short enough not to sit on a
 *  connection the far end has quietly dropped. */
const IDLE_TIMEOUT_MS = 45_000;

const idlePool: WebSocket[] = [];
const idleTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();
/** The close listener added each time a socket is pooled. It has to come off
 *  again when the socket leaves the pool: `once` only removes itself if the
 *  socket closes, so a socket reused a dozen times carried a dozen of them
 *  and Node logged MaxListenersExceededWarning. */
const idleCloseListeners = new Map<WebSocket, () => void>();

function dropFromPool(socket: WebSocket): void {
  const index = idlePool.indexOf(socket);
  if (index !== -1) idlePool.splice(index, 1);
  const timer = idleTimers.get(socket);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(socket);
  }
  const onClose = idleCloseListeners.get(socket);
  if (onClose) {
    socket.off("close", onClose);
    idleCloseListeners.delete(socket);
  }
}

function takeIdleConnection(): WebSocket | null {
  while (idlePool.length) {
    const socket = idlePool[idlePool.length - 1];
    dropFromPool(socket);
    if (socket.readyState === WebSocket.OPEN) return socket;
    // Closed or closing while idle — keep looking rather than handing back
    // a connection that can't actually take a turn.
  }
  return null;
}

function releaseConnection(socket: WebSocket): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (idlePool.length >= MAX_POOL_SIZE) {
    try {
      socket.close();
    } catch {
      /* already closing */
    }
    return;
  }
  idlePool.push(socket);
  const onClose = () => dropFromPool(socket);
  idleCloseListeners.set(socket, onClose);
  socket.once("close", onClose);
  idleTimers.set(
    socket,
    setTimeout(() => {
      dropFromPool(socket);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }, IDLE_TIMEOUT_MS),
  );
}

/**
 * Which endpoint answered last. The first handshake on a fresh instance may
 * cost one refused round trip if the first host has gone; every connection
 * after it goes straight to the one that worked. When every host refuses,
 * the order starts over on the next call rather than sticking on the last.
 */
let preferredEndpoint = 0;

/** A no-op listener that stays attached for the life of the socket. The ws
 *  library emits `error` on a socket whose handshake was refused (the server
 *  resets the connection after its 403) and on an idle pooled socket the far
 *  end drops, and an `error` with no listener is an uncaught exception that
 *  takes the server down. Every real listener is added on top of this. */
function swallowErrors(): void {
  /* intentionally empty */
}

function openOne(endpoint: EdgeEndpoint): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(synthesisUrl(endpoint), { headers: edgeHeaders() });
    socket.on("error", swallowErrors);
    // A host that accepts the connection and never upgrades it would
    // otherwise hold the passage for the whole timeout instead of moving on.
    const timer = setTimeout(() => {
      detach();
      socket.terminate();
      reject(new EdgeSynthesisError("The voice service did not complete the handshake."));
    }, HANDSHAKE_TIMEOUT_MS);
    const onOpen = () => {
      detach();
      resolve(socket);
    };
    const onError = (error: Error) => {
      detach();
      reject(new EdgeSynthesisError(error.message));
    };
    const onUnexpected = (_request: unknown, response: { statusCode?: number }) => {
      detach();
      reject(
        new EdgeSynthesisError(
          `The voice service refused the request (HTTP ${response.statusCode}).`,
          response.statusCode,
        ),
      );
    };
    function detach(): void {
      clearTimeout(timer);
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpected);
    }
    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("unexpected-response", onUnexpected);
  });
}

/** A refused handshake or an unreachable host moves on to the next endpoint;
 *  an open socket makes its endpoint the preferred one. */
async function openConnection(): Promise<WebSocket> {
  const endpoints = edgeEndpoints();
  const start = Math.min(preferredEndpoint, endpoints.length - 1);
  let lastError: EdgeSynthesisError | null = null;
  for (let i = 0; i < endpoints.length; i++) {
    const index = (start + i) % endpoints.length;
    try {
      const socket = await openOne(endpoints[index]);
      preferredEndpoint = index;
      return socket;
    } catch (error) {
      lastError = error instanceof EdgeSynthesisError ? error : new EdgeSynthesisError(String(error));
    }
  }
  preferredEndpoint = 0;
  throw lastError ?? new EdgeSynthesisError("The voice service is unreachable.");
}

function acquireConnection(fresh: boolean): Promise<WebSocket> {
  const idle = fresh ? null : takeIdleConnection();
  return idle ? Promise.resolve(idle) : openConnection();
}

interface RawBoundary {
  Offset: number;
  Duration: number;
  text?: { Text?: string; Length?: number };
}

/**
 * Boundaries come back as the spoken word, not an offset into our text, and
 * the engine normalises as it speaks ("Mrs." may be voiced as something else
 * entirely). Walking forward through the source and taking the first match
 * after the cursor keeps the two in step; a word that cannot be found leaves
 * the cursor where it is, so the highlight holds rather than jumping somewhere
 * wrong, and catches up on the next word that does match.
 */
function mapToCharIndices(text: string, boundaries: RawBoundary[]): TimedWord[] {
  const words: TimedWord[] = [];
  let cursor = 0;

  for (const boundary of boundaries) {
    const spoken = boundary.text?.Text ?? "";
    let charIndex = cursor;
    let charLength = spoken.length;

    if (spoken) {
      const found = text.indexOf(spoken, cursor);
      if (found >= 0) {
        charIndex = found;
        cursor = found + spoken.length;
      } else {
        // Try a case-insensitive search before giving up on this word.
        const lower = text.toLowerCase().indexOf(spoken.toLowerCase(), cursor);
        if (lower >= 0) {
          charIndex = lower;
          cursor = lower + spoken.length;
        } else {
          charLength = 0;
        }
      }
    }

    words.push({
      charIndex,
      charLength,
      offsetMs: Math.round(boundary.Offset / 10_000),
      durationMs: Math.round(boundary.Duration / 10_000),
    });
  }
  return words;
}

function sendTurn(socket: WebSocket, text: string, voice: string, rate: number): void {
  const config = {
    context: {
      synthesis: {
        audio: {
          metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "true" },
          outputFormat: OUTPUT_FORMAT,
        },
      },
    },
  };
  socket.send(
    `X-Timestamp:${new Date().toISOString()}\r\n` +
      `Content-Type:application/json; charset=utf-8\r\n` +
      `Path:speech.config\r\n\r\n` +
      JSON.stringify(config),
  );

  const ssml = buildSsml(text, voice, rate);

  socket.send(
    `X-RequestId:${randomUUID().replace(/-/g, "")}\r\n` +
      `Content-Type:application/ssml+xml\r\n` +
      `X-Timestamp:${new Date().toISOString()}Z\r\n` +
      `Path:ssml\r\n\r\n` +
      ssml,
  );
}

/** One request and its answer on one connection. */
function synthesizeTurn(
  text: string,
  voice: string,
  rate: number,
  timeoutMs: number,
  fresh: boolean,
): Promise<Synthesis> {
  return new Promise<Synthesis>((resolve, reject) => {
    let socket: WebSocket | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    const boundaries: RawBoundary[] = [];
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(
        () => finish(new EdgeSynthesisError("The voice service stopped answering.")),
        STALL_MS,
      );
    };

    const finish = (error: Error | null, result?: Synthesis) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stall);
      if (socket) {
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("message", onMessage);
      }
      if (error) {
        try {
          socket?.close();
        } catch {
          /* already closing */
        }
        reject(error);
      } else if (socket) {
        releaseConnection(socket);
        resolve(result!);
      }
    };

    const timer = setTimeout(
      () => finish(new EdgeSynthesisError("The voice service did not answer in time.")),
      timeoutMs,
    );

    const onError = (error: Error) => finish(new EdgeSynthesisError(error.message));
    const onClose = () => finish(new EdgeSynthesisError("The voice service closed the connection early."));

    const onMessage = (data: Buffer, isBinary: boolean) => {
      armStall();
      if (isBinary) {
        // Two-byte big-endian header length, then the header, then audio.
        if (data.length < 2) return;
        const headerLength = data.readUInt16BE(0);
        chunks.push(data.subarray(2 + headerLength));
        return;
      }

      const message = data.toString();
      if (message.includes("Path:audio.metadata")) {
        const body = message.slice(message.indexOf("\r\n\r\n") + 4);
        try {
          const parsed = JSON.parse(body) as { Metadata?: { Type: string; Data: RawBoundary }[] };
          for (const item of parsed.Metadata ?? []) {
            if (item.Type === "WordBoundary") boundaries.push(item.Data);
          }
        } catch {
          /* a malformed metadata frame costs one word of precision */
        }
        return;
      }

      if (message.includes("Path:turn.end")) {
        const audio = Buffer.concat(chunks);
        if (!audio.length) {
          finish(new EdgeSynthesisError("The voice service returned no audio."));
          return;
        }
        finish(null, { audio, words: mapToCharIndices(text, boundaries) });
      }
    };

    acquireConnection(fresh)
      .then((connection) => {
        if (settled) {
          // The timeout already fired while a fresh connection was still
          // connecting; it's still good, just not needed for this call.
          releaseConnection(connection);
          return;
        }
        socket = connection;
        socket.on("error", onError);
        socket.on("close", onClose);
        socket.on("message", onMessage);
        armStall();
        sendTurn(socket, text, voice, rate);
      })
      .catch((error: unknown) => {
        finish(error instanceof EdgeSynthesisError ? error : new EdgeSynthesisError(String(error)));
      });
  });
}

/** A character range of the passage, synthesised on a connection of its own. */
export interface PieceRange {
  start: number;
  end: number;
}

/** Where a sentence may end: terminal punctuation, any closing quotes or
 *  brackets, then whitespace. */
const SENTENCE_END = /[.!?…]["'”’)\]]*\s+/g;

/**
 * Cuts a passage into pieces at sentence ends, each about `length / maxPieces`
 * long, so a short passage goes out a sentence per piece and a long one in
 * about `maxPieces`. A
 * sentence is never split, however long: a piece that ends mid-sentence
 * would be read with a full stop's fall in the middle of it.
 */
export function splitPassage(text: string, maxPieces = MAX_PARALLEL_TURNS): PieceRange[] {
  const target = Math.ceil(text.length / maxPieces);
  const pieces: PieceRange[] = [];
  let start = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].trimEnd().length;
    const next = match.index + match[0].length;
    if (end - start >= target && next < text.length && !shouldMerge(text.slice(start, end), text.slice(next))) {
      pieces.push({ start, end });
      start = next;
    }
  }
  if (start < text.length) pieces.push({ start, end: text.trimEnd().length });
  return pieces.filter((piece) => piece.end > piece.start);
}

/** Puts the pieces' audio end to end and moves each word onto the passage:
 *  its character index by where the piece began, its time by the audio
 *  before it. */
export function joinPieces(pieces: { range: PieceRange; synthesis: Synthesis }[]): Synthesis {
  const words: TimedWord[] = [];
  let elapsedMs = 0;
  for (const { range, synthesis } of pieces) {
    for (const word of synthesis.words) {
      words.push({
        ...word,
        charIndex: word.charIndex + range.start,
        offsetMs: Math.round(word.offsetMs + elapsedMs),
      });
    }
    elapsedMs += synthesis.audio.length / OUTPUT_BYTES_PER_MS;
  }
  return { audio: Buffer.concat(pieces.map((piece) => piece.synthesis.audio)), words };
}

/** A piece that fails is tried once more on a new connection, since the
 *  usual cause is a pooled socket the far end had dropped. */
async function synthesizePiece(text: string, voice: string, rate: number, deadline: number): Promise<Synthesis> {
  try {
    return await synthesizeTurn(text, voice, rate, deadline - Date.now(), false);
  } catch (error) {
    if (deadline - Date.now() < STALL_MS) throw error;
    return synthesizeTurn(text, voice, rate, deadline - Date.now(), true);
  }
}

export async function synthesize(text: string, voice: string, rate: number): Promise<Synthesis> {
  const deadline = Date.now() + TIMEOUT_MS;
  const ranges = splitPassage(text);
  const results = await Promise.all(
    ranges.map((range) => synthesizePiece(text.slice(range.start, range.end), voice, rate, deadline)),
  );
  return joinPieces(ranges.map((range, i) => ({ range, synthesis: results[i] })));
}
