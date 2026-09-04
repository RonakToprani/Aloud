import { isSameOrigin, withinRateLimit } from "@/lib/speech/edge/guard";
import { EdgeSynthesisError, synthesize } from "@/lib/speech/edge/synthesize";

/** A reader sentence is a few dozen words at most; this is generous headroom
 *  against a request built to hold the socket open synthesising a novel. */
const MAX_TEXT_LENGTH = 4000;
/** Real ShortNames are hyphen-separated alphanumerics ("en-US-AriaNeural").
 *  The value is interpolated into an SSML attribute unescaped, so anything
 *  outside that shape is rejected rather than sanitised. */
const SAFE_VOICE_NAME = /^[A-Za-z0-9-]{1,100}$/;

interface SynthesizeBody {
  text?: unknown;
  voice?: unknown;
  rate?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!withinRateLimit(request)) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }

  let body: SynthesizeBody;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { text, voice, rate } = body;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
    return Response.json({ error: "Invalid text." }, { status: 400 });
  }
  if (typeof voice !== "string" || !SAFE_VOICE_NAME.test(voice)) {
    return Response.json({ error: "Invalid voice." }, { status: 400 });
  }
  const numericRate = typeof rate === "number" && Number.isFinite(rate) ? rate : 1;

  try {
    const { audio, words } = await synthesize(text, voice, numericRate);
    return Response.json({ audio: audio.toString("base64"), words });
  } catch (error) {
    if (error instanceof EdgeSynthesisError) {
      return Response.json({ error: error.message }, { status: error.status ?? 502 });
    }
    return Response.json({ error: "The voice service failed." }, { status: 502 });
  }
}
