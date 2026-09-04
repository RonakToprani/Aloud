import { isSameOrigin, withinRateLimit } from "@/lib/speech/edge/guard";
import { getEdgeVoices } from "@/lib/speech/edge/voices";

export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!withinRateLimit(request)) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }

  const locale = new URL(request.url).searchParams.get("locale") ?? undefined;

  try {
    const voices = await getEdgeVoices(locale ?? undefined);
    return Response.json(voices, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch {
    return Response.json({ error: "The voice list is unavailable." }, { status: 502 });
  }
}
