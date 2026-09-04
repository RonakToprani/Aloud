import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { edgeHeaders, escapeSsml, ratePercent, synthesisUrl } from "./protocol";

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

const TIMEOUT_MS = 20_000;
const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

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

export function synthesize(text: string, voice: string, rate: number): Promise<Synthesis> {
  return new Promise<Synthesis>((resolve, reject) => {
    const socket = new WebSocket(synthesisUrl(), { headers: edgeHeaders() });
    const chunks: Buffer[] = [];
    const boundaries: RawBoundary[] = [];
    let settled = false;

    const finish = (error: Error | null, result?: Synthesis) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closing */
      }
      if (error) reject(error);
      else resolve(result!);
    };

    const timer = setTimeout(
      () => finish(new EdgeSynthesisError("The voice service did not answer in time.")),
      TIMEOUT_MS,
    );

    socket.on("unexpected-response", (_request, response) => {
      finish(
        new EdgeSynthesisError(
          `The voice service refused the request (HTTP ${response.statusCode}).`,
          response.statusCode,
        ),
      );
    });

    socket.on("error", (error: Error) => {
      finish(new EdgeSynthesisError(error.message));
    });

    socket.on("open", () => {
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

      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${voice}'>` +
        `<prosody pitch='+0Hz' rate='${ratePercent(rate)}' volume='+0%'>${escapeSsml(text)}</prosody>` +
        `</voice></speak>`;

      socket.send(
        `X-RequestId:${randomUUID().replace(/-/g, "")}\r\n` +
          `Content-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${new Date().toISOString()}Z\r\n` +
          `Path:ssml\r\n\r\n` +
          ssml,
      );
    });

    socket.on("message", (data: Buffer, isBinary: boolean) => {
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
    });

    socket.on("close", () => {
      finish(new EdgeSynthesisError("The voice service closed the connection early."));
    });
  });
}
