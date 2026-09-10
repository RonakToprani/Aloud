/**
 * The public library: Project Gutenberg, reached through this app's own API
 * routes. Nothing here talks to gutenberg.org directly, because it sends no
 * CORS headers; the routes give the browser one small, stable view of it.
 * The catalogue itself is baked into the build (see scripts/gutenberg-shelf.ts),
 * so browsing is instant and works when Gutenberg's mirrors do not.
 */

export interface CatalogueBook {
  id: number;
  /** The title with its long subtitle taken off, for a shelf. */
  title: string;
  /** What was taken off, for the detail sheet. */
  subtitle: string | null;
  author: string | null;
  /** Lifetime downloads on Gutenberg, the nearest thing to popularity. */
  downloads: number;
  subjects: string[];
  summary: string | null;
  hasCover: boolean;
}

export interface CataloguePage {
  books: CatalogueBook[];
  /** Page number to ask for next, or null at the end. */
  next: number | null;
  total: number;
}

export interface Genre {
  /** What the reader sees. */
  label: string;
  /** What Gutendex matches against subjects and bookshelves. */
  topic: string;
}

/** A dozen doors into a library of seventy thousand. Topics are chosen for
 *  what they return, not for their names: "detective" finds the mysteries
 *  and "love stories" the romances, where the plain words find noise. */
export const GENRES: Genre[] = [
  { label: "Fiction", topic: "fiction" },
  { label: "Mystery", topic: "detective" },
  { label: "Adventure", topic: "adventure" },
  { label: "Romance", topic: "love stories" },
  { label: "Science fiction", topic: "science fiction" },
  { label: "Fantasy", topic: "fantasy" },
  { label: "Horror", topic: "horror" },
  { label: "Short stories", topic: "short stories" },
  { label: "Poetry", topic: "poetry" },
  { label: "Philosophy", topic: "philosophy" },
  { label: "History", topic: "history" },
  { label: "Children's", topic: "children" },
];

export class CatalogueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogueError";
  }
}

export interface CatalogueQuery {
  topic?: string;
  search?: string;
  page?: number;
}

export async function fetchCatalogue(
  query: CatalogueQuery,
  signal?: AbortSignal,
): Promise<CataloguePage> {
  const params = new URLSearchParams();
  if (query.topic) params.set("topic", query.topic);
  if (query.search) params.set("search", query.search);
  if (query.page && query.page > 1) params.set("page", String(query.page));
  const response = await fetch(`/api/gutenberg/books?${params}`, { signal });
  if (!response.ok) {
    throw new CatalogueError("The library can't be reached right now. Try again in a moment.");
  }
  return (await response.json()) as CataloguePage;
}

/** Gutenberg's own cover art, sized for a shelf. Fine to show straight from
 *  their server; only fetching it as data needs the proxy. */
export function coverUrl(id: number): string {
  return `https://www.gutenberg.org/cache/epub/${id}/pg${id}.cover.medium.jpg`;
}

/** "Austen, Jane" is how a catalogue files a name, not how a person says
 *  it. Parentheticals carry alternate names and are left off. */
export function displayName(catalogued: string): string {
  const bare = catalogued.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  // "Tolstoy, Leo, graf": family, given, and then honours nobody says aloud.
  const [family, given] = bare.split(",").map((part) => part.trim());
  if (!given) return family;
  return `${given} ${family}`;
}

/** "Moby Dick; Or, The Whale" and "The Odyssey: Rendered into English prose
 *  for the use of those who cannot read the original" both want cutting at
 *  the first mark, as long as what is left is still a title. */
export function splitTitle(full: string): { title: string; subtitle: string | null } {
  const cleaned = full.replace(/\s+/g, " ").trim();
  const match = cleaned.match(/^(.{3,}?)\s*[;:]\s+(?:or,?\s+)?(.+)$/i);
  if (!match) return { title: cleaned, subtitle: null };
  return { title: match[1], subtitle: match[2] };
}
