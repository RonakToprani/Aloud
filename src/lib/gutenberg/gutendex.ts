import { displayName, splitTitle, type CatalogueBook } from "./catalogue";

/**
 * Gutendex is a mirror of Project Gutenberg's catalogue with a JSON face on
 * it, run by one volunteer. Its records are large and its server is slow
 * and sometimes away. What the app keeps of a record is here, shared by the
 * live route and the script that bakes the front page.
 */

export const GUTENDEX = "https://gutendex.com/books/";

export interface GutendexBook {
  id: number;
  title: string;
  authors: { name: string }[];
  subjects: string[];
  bookshelves: string[];
  languages: string[];
  download_count: number;
  summaries?: string[];
  formats: Record<string, string>;
}

export interface GutendexPage {
  count: number;
  next: string | null;
  results: GutendexBook[];
}

/** Catalogue subjects read "Courtship -- Fiction"; a person wants "Courtship". */
function tidySubjects(subjects: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of subjects) {
    const head = raw.split(" -- ")[0].trim();
    const key = head.toLowerCase();
    if (!head || seen.has(key) || key === "fiction") continue;
    seen.add(key);
    out.push(head);
    if (out.length === 3) break;
  }
  return out;
}

/** One catalogue record, cut down to what a shelf shows. Null when there is
 *  no EPUB: a handful of entries are audio or images only, and would sit on
 *  the shelf as dead ends. */
export function slim(book: GutendexBook): CatalogueBook | null {
  if (!book.formats["application/epub+zip"]) return null;
  const { title, subtitle } = splitTitle(book.title);
  return {
    id: book.id,
    title,
    subtitle,
    author: book.authors[0] ? displayName(book.authors[0].name) : null,
    downloads: book.download_count,
    subjects: tidySubjects(book.subjects),
    summary: book.summaries?.[0]?.trim() || null,
    hasCover: Boolean(book.formats["image/jpeg"]),
  };
}

export function gutendexUrl(query: { topic?: string; search?: string; page?: number }): URL {
  const url = new URL(GUTENDEX);
  url.searchParams.set("languages", "en");
  url.searchParams.set("sort", "popular");
  if (query.topic) url.searchParams.set("topic", query.topic);
  if (query.search) url.searchParams.set("search", query.search);
  if (query.page && query.page > 1) url.searchParams.set("page", String(query.page));
  return url;
}
