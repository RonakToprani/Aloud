/**
 * Hands a Gutenberg EPUB to the browser. gutenberg.org sends no CORS
 * headers, so the page cannot fetch one itself; this passes the bytes
 * straight through without holding them.
 *
 * Always the edition without images. It is a twentieth the size (half a
 * megabyte against twenty for a novel), the reader never shows pictures,
 * and what a phone keeps is the parsed text, so the download is the only
 * place the difference would be felt and it is felt on a mobile connection.
 */

const YEAR = 31536000;
/** How long to wait for Gutenberg to start answering. The body is streamed
 *  through afterwards on its own time: a deadline on the fetch would also
 *  cut the stream, and the browser would get a file short of its stated
 *  length with no error worth showing. */
const HEADERS_TIMEOUT_MS = 20000;
export const maxDuration = 60;

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^\d{1,7}$/.test(id)) return new Response("Not found", { status: 404 });

  const control = new AbortController();
  const deadline = setTimeout(() => control.abort(), HEADERS_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(`https://www.gutenberg.org/ebooks/${id}.epub.noimages`, {
      redirect: "follow",
      headers: { "user-agent": "Aloud (read-along reader; https://aloudreader.vercel.app)" },
      signal: control.signal,
    });
  } catch {
    return new Response("Project Gutenberg didn't answer.", { status: 502 });
  } finally {
    clearTimeout(deadline);
  }

  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !upstream.body || !/epub|octet-stream/.test(type)) {
    return new Response("That book isn't available as an EPUB.", { status: 404 });
  }

  const headers = new Headers({
    "content-type": "application/epub+zip",
    // A Gutenberg edition is effectively immutable once published.
    "cache-control": `public, max-age=${YEAR}, s-maxage=${YEAR}, immutable`,
  });
  const length = upstream.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(upstream.body, { headers });
}
