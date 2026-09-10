/**
 * Bakes the public library into the repo.
 *
 *   npx tsx scripts/gutenberg-shelf.ts
 *
 * Gutendex answers its popularity list in a fifth of a second and its
 * topic and search queries in half a minute, when it answers them at all.
 * So the app never asks it those. This pulls the few thousand most-read
 * English books off the fast list, sorts them into genres by their own
 * subject headings, and writes src/lib/gutenberg/shelf.json, which the
 * browse route answers from entirely: front page, genres and search.
 *
 * Popularity on Gutenberg moves slowly. Run this a few times a year.
 */

import { writeFileSync } from "node:fs";
import { GENRES, type CatalogueBook } from "../src/lib/gutenberg/catalogue";
import { gutendexUrl, slim, type GutendexBook, type GutendexPage } from "../src/lib/gutenberg/gutendex";

const OUT = new URL("../src/lib/gutenberg/shelf.json", import.meta.url);
/** 32 a page. A hundred pages is deep enough that what is missing is
 *  obscure, and shallow enough to fit a serverless bundle with room. */
const PAGES = 100;
const PER_GENRE = 96;
const SUMMARY_CHARS = 600;

/** What a genre means, in the words Gutenberg's own subject headings use. */
const RULES: Record<string, { any: string[]; none?: string[] }> = {
  fiction: { any: ["fiction"], none: ["juvenile", "children's"] },
  detective: { any: ["detective", "mystery"] },
  adventure: { any: ["adventure"] },
  "love stories": { any: ["love stories", "romance"] },
  "science fiction": { any: ["science fiction"] },
  fantasy: { any: ["fantasy", "fairy tales", "folklore"] },
  horror: { any: ["horror", "ghost stories", "gothic", "vampire"] },
  "short stories": { any: ["short stories"] },
  poetry: { any: ["poetry", "poems"] },
  philosophy: { any: ["philosophy", "ethics"] },
  history: { any: ["history"], none: ["fiction"] },
  children: { any: ["children's", "juvenile fiction", "juvenile literature"] },
};

async function page(n: number, attempt = 1): Promise<GutendexPage> {
  try {
    const response = await fetch(gutendexUrl({ page: n }), { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${response.status}`);
    return (await response.json()) as GutendexPage;
  } catch (failure) {
    if (attempt >= 5) throw failure;
    await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    return page(n, attempt + 1);
  }
}

async function main() {
  const raw: GutendexBook[] = [];
  for (let n = 1; n <= PAGES; n += 4) {
    const batch = await Promise.all(
      Array.from({ length: Math.min(4, PAGES - n + 1) }, (_, i) => page(n + i)),
    );
    for (const result of batch) raw.push(...result.results);
    process.stdout.write(`\r${raw.length} records`);
  }
  console.log();

  const seen = new Set<number>();
  const pool: CatalogueBook[] = [];
  const headings = new Map<number, string>();
  for (const record of raw) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    const book = slim(record);
    if (!book) continue;
    if (book.summary && book.summary.length > SUMMARY_CHARS) {
      book.summary = `${book.summary.slice(0, SUMMARY_CHARS).replace(/\s+\S*$/, "")}…`;
    }
    pool.push(book);
    headings.set(book.id, [...record.subjects, ...record.bookshelves].join(" | ").toLowerCase());
  }
  pool.sort((a, b) => b.downloads - a.downloads);

  // Gutenberg holds several editions of its favourites under different
  // numbers. One Dracula on the shelf is enough, and it should be the one
  // most people chose.
  const editions = new Set<string>();
  for (let i = 0; i < pool.length; i++) {
    const key = `${pool[i].title}|${pool[i].author ?? ""}`
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (editions.has(key)) {
      pool.splice(i, 1);
      i--;
    } else {
      editions.add(key);
    }
  }

  const genres: Record<string, number[]> = {};
  for (const genre of GENRES) {
    const rule = RULES[genre.topic];
    genres[genre.topic] = pool
      .filter((book) => {
        const text = headings.get(book.id) ?? "";
        return rule.any.some((word) => text.includes(word)) && !rule.none?.some((word) => text.includes(word));
      })
      .slice(0, PER_GENRE)
      .map((book) => book.id);
    console.log(`${genre.label.padEnd(16)} ${genres[genre.topic].length}`);
  }

  writeFileSync(OUT, JSON.stringify({ bakedAt: new Date().toISOString().slice(0, 10), pool, genres }));
  console.log(`${pool.length} books, wrote ${OUT.pathname}`);
}

void main();
