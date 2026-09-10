import { NextResponse } from "next/server";
import type { CatalogueBook, CataloguePage } from "@/lib/gutenberg/catalogue";
import shelf from "@/lib/gutenberg/shelf.json";

/**
 * The catalogue, as the browse screen sees it: the few thousand most-read
 * books on Project Gutenberg, baked into the build by
 * scripts/gutenberg-shelf.ts and answered from memory.
 *
 * Nothing here goes to the network. Gutendex, the only JSON view of the
 * catalogue, answers topic and search queries in half a minute or not at
 * all, and a shelf that is empty on a bad afternoon is worse than one that
 * is a season out of date. Search is over the baked pool too: titles,
 * authors and subject headings, which for books this well known is enough.
 */

const PAGE = 32;
const HOLD_SECONDS = 86400;

interface Baked {
  bakedAt: string;
  pool: CatalogueBook[];
  genres: Record<string, number[]>;
}

const baked = shelf as Baked;
const byId = new Map(baked.pool.map((book) => [book.id, book]));
/** Lowercased, once, so a search is a handful of includes per book. */
const haystacks = new Map(
  baked.pool.map((book) => [
    book.id,
    [book.title, book.subtitle ?? "", book.author ?? "", ...book.subjects].join(" ").toLowerCase(),
  ]),
);

function slice(books: CatalogueBook[], page: number): CataloguePage {
  const start = (page - 1) * PAGE;
  return {
    books: books.slice(start, start + PAGE),
    next: start + PAGE < books.length ? page + 1 : null,
    total: books.length,
  };
}

function search(query: string): CatalogueBook[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.replace(/[^\p{L}\p{N}']/gu, ""))
    .filter((term) => term.length > 1);
  if (!terms.length) return [];
  return baked.pool.filter((book) => {
    const text = haystacks.get(book.id) ?? "";
    return terms.every((term) => text.includes(term));
  });
}

export function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const topic = searchParams.get("topic")?.trim().slice(0, 40) ?? "";
  const query = searchParams.get("search")?.trim().slice(0, 80) ?? "";
  const page = Math.max(1, Math.min(200, Number(searchParams.get("page")) || 1));

  let books: CatalogueBook[];
  if (query) {
    books = search(query);
  } else if (topic) {
    const ids = baked.genres[topic];
    if (!ids) return NextResponse.json({ error: "No such shelf." }, { status: 404 });
    books = ids.map((id) => byId.get(id)).filter((book): book is CatalogueBook => book !== undefined);
  } else {
    books = baked.pool.slice(0, 96);
  }

  return NextResponse.json(slice(books, page), {
    headers: {
      "cache-control": `public, s-maxage=${HOLD_SECONDS}, stale-while-revalidate=${HOLD_SECONDS * 7}`,
    },
  });
}
