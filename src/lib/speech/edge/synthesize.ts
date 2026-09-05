import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { edgeHeaders, synthesisUrl } from "./protocol";
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

/** A passage is minutes of audio, not one sentence, and synthesis time scales
 *  with the text. The next passage is requested a whole passage ahead, so a
 *  slow one costs margin rather than silence. */
const TIMEOUT_MS = 55_000;
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

/**
 * Connection pooling: the reader prefetches the next sentence while the
 * current one plays, so a connection this call opens is almost always sitting
 * idle again well before the next sentence needs one. Reusing it skips the
 * WebSocket handshake — the dominant cost we measured, roughly as long as
 * synthesis itself — for every sentence after the first. Kept small since
 * only one turn can run on a connection at a time; anything beyond what's
 * idle just opens fresh, exactly like before pooling existed.
 */
const MAX_POOL_SIZE = 3;
/** Long enough to outlast a slow sentence, short enough not to sit on a
 *  connection the far end has quietly dropped. */
const IDLE_TIMEOUT_MS = 45_000;

const idlePool: WebSocket[] = [];
const idleTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();

function dropFromPool(socket: WebSocket): void {
  const index = idlePool.indexOf(socket);
  if (index !== -1) idlePool.splice(index, 1);
  const timer = idleTimers.get(socket);
  if (timer) {
    clearTimeout(timer);
    idleTimers.delete(socket);
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
  socket.once("close", () => dropFromPool(socket));
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

function openConnection(): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(synthesisUrl(), { headers: edgeHeaders() });
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
      socket.off("open", onOpen);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpected);
    }
    socket.on("open", onOpen);
    socket.on("error", onError);
    socket.on("unexpected-response", onUnexpected);
  });
}

function acquireConnection(): Promise<WebSocket> {
  const idle = takeIdleConnection();
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

export function synthesize(text: string, voice: string, rate: number): Promise<Synthesis> {
  return new Promise<Synthesis>((resolve, reject) => {
    let socket: WebSocket | undefined;
    let settled = false;
    const chunks: Buffer[] = [];
    const boundaries: RawBoundary[] = [];

    const finish = (error: Error | null, result?: Synthesis) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
      TIMEOUT_MS,
    );

    const onError = (error: Error) => finish(new EdgeSynthesisError(error.message));
    const onClose = () => finish(new EdgeSynthesisError("The voice service closed the connection early."));

    const onMessage = (data: Buffer, isBinary: boolean) => {
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

    acquireConnection()
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
        sendTurn(socket, text, voice, rate);
      })
      .catch((error: unknown) => {
        finish(error instanceof EdgeSynthesisError ? error : new EdgeSynthesisError(String(error)));
      });
  });
}
