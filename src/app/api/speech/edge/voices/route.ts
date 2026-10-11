import { isSameOrigin, withinRateLimit } from "@/lib/speech/edge/guard";
import { getEdgeVoices } from "@/lib/speech/edge/voices";

async function respond(request: Request, locale: string | undefined): Promise<Response> {
  if (!isSameOrigin(request)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!withinRateLimit(request)) {
    return Response.json({ error: "Too many requests" }, { status: 429 });
  }
  try {
    const voices = await getEdgeVoices(locale);
    return Response.json(voices, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch {
    return Response.json({ error: "The voice list is unavailable." }, { status: 502 });
  }
}

export async function GET(request: Request): Promise<Response> {
  const locale = new URL(request.url).searchParams.get("locale") ?? undefined;
  return respond(request, locale);
}

/**
 * The browser extension asks for the list this way. Chrome sends no Origin
 * and no Referer on a plain GET from an extension's service worker, so the
 * origin guard cannot tell it from an anonymous caller; a POST carries
 * `Origin: chrome-extension://<id>`, which is what the guard admits.
 */
export async function POST(request: Request): Promise<Response> {
  let locale: string | undefined;
  try {
    const body: unknown = await request.json();
    const value = body && typeof body === "object" ? (body as { locale?: unknown }).locale : undefined;
    if (typeof value === "string" && /^[A-Za-z-]{0,20}$/.test(value)) locale = value || undefined;
  } catch {
    /* no body means every locale, as the GET without a query does */
  }
  return respond(request, locale);
}
