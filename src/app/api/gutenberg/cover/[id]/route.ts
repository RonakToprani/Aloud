/**
 * A cover, for the shelf and for keeping with the book. Both go through
 * here rather than to gutenberg.org: the store needs a fetch, which needs
 * CORS headers gutenberg.org does not send, and the shelf would otherwise
 * send a burst of thirty requests to a volunteer-run site for every page
 * turned. Held at the edge for a year, so each cover is fetched once.
 */

const YEAR = 31536000;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^\d{1,7}$/.test(id)) return new Response("Not found", { status: 404 });

  let upstream: Response;
  try {
    upstream = await fetch(`https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`, {
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    return new Response("No cover.", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) return new Response("No cover.", { status: 404 });

  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "image/jpeg",
      "cache-control": `public, max-age=${YEAR}, s-maxage=${YEAR}, immutable`,
    },
  });
}
