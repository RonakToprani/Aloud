"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { BookCover } from "@/components/library/BookCover";
import { Sheet } from "@/components/ui/Sheet";
import { BackIcon, CheckIcon, CloseIcon, PlayIcon, PlusIcon, SearchIcon } from "@/components/ui/Icons";
import { Toast, type ToastMessage } from "@/components/ui/Toast";
import {
  coverUrl,
  fetchCatalogue,
  GENRES,
  type CatalogueBook,
  type CataloguePage,
  type Genre,
} from "@/lib/gutenberg/catalogue";
import { requestAutoplay } from "@/lib/library/autoplay";
import { addGutenbergBook } from "@/lib/library/gutenberg";
import { describeImportError, type ImportProgress } from "@/lib/library/import";
import { listBooks } from "@/lib/storage/db";
import { pushBooks } from "@/lib/sync/remote";
import type { BookMeta } from "@/lib/types";
import styles from "./Browse.module.css";

/** What the page is showing: the front, one genre, or a search. */
type Mode = { kind: "home" } | { kind: "genre"; genre: Genre } | { kind: "search"; query: string };

const SEARCH_DEBOUNCE_MS = 350;

const STAGE_TEXT: Record<ImportProgress["stage"], string> = {
  reading: "Fetching from Project Gutenberg",
  parsing: "Opening the book",
  indexing: "Counting the sentences",
  saving: "Putting it on the shelf",
};

/** A shelf cover needs a BookMeta; a catalogue entry has the parts of one. */
function coverMeta(book: CatalogueBook): BookMeta {
  return {
    id: `gutenberg-${book.id}`,
    title: book.title,
    author: book.author,
    source: "epub",
    addedAt: 0,
    sentenceCount: 0,
    chapterTitles: [],
    chapterSentenceCounts: [],
    chapterWordCounts: [],
    wordCount: 0,
  };
}

function formatCount(n: number): string {
  return n.toLocaleString("en-GB");
}

export function BrowseView() {
  const router = useRouter();
  const { ensureAccount } = useAuth();

  const [popular, setPopular] = useState<CatalogueBook[] | null>(null);
  const [popularError, setPopularError] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "home" });
  const [results, setResults] = useState<CataloguePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Gutenberg id → the copy already on this device. */
  const [shelf, setShelf] = useState<Map<number, BookMeta>>(new Map());
  const [selected, setSelected] = useState<CatalogueBook | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [addError, setAddError] = useState<{ title: string; detail: string } | null>(null);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const listRequest = useRef<AbortController | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  /* ---------------- what is already here ---------------- */

  const refreshShelf = useCallback(async () => {
    try {
      const books = await listBooks();
      const map = new Map<number, BookMeta>();
      for (const book of books) if (book.gutenbergId !== undefined) map.set(book.gutenbergId, book);
      setShelf(map);
    } catch {
      /* the shelf is a nicety here; browsing works without it */
    }
  }, []);

  useEffect(() => {
    void refreshShelf();
  }, [refreshShelf]);

  /* ---------------- the front page ---------------- */

  useEffect(() => {
    const controller = new AbortController();
    fetchCatalogue({}, controller.signal)
      .then((page) => setPopular(page.books))
      .catch((failure) => {
        if (failure?.name !== "AbortError") setPopularError(true);
      });
    return () => controller.abort();
  }, []);

  /* ---------------- a genre or a search ---------------- */

  const load = useCallback((next: Mode) => {
    listRequest.current?.abort();
    // An aborted "show more" never reports back; its flag is cleared here or
    // the next shelf is stuck on "Loading" for the rest of the visit.
    setLoadingMore(false);
    if (next.kind === "home") {
      listRequest.current = null;
      setResults(null);
      setListError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    listRequest.current = controller;
    setResults(null);
    setListError(null);
    setLoading(true);
    const query = next.kind === "genre" ? { topic: next.genre.topic } : { search: next.query };
    fetchCatalogue(query, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setResults(page);
        setLoading(false);
      })
      .catch((failure) => {
        if (controller.signal.aborted) return;
        setListError(failure instanceof Error ? failure.message : "Something went wrong.");
        setLoading(false);
      });
  }, []);

  const show = useCallback(
    (next: Mode) => {
      setMode(next);
      load(next);
      if (next.kind !== "search") setSearch("");
      window.scrollTo({ top: 0 });
    },
    [load],
  );

  // Typing searches after a pause; clearing the field goes back to the front.
  useEffect(() => {
    const query = search.trim();
    if (!query) {
      if (mode.kind === "search") show({ kind: "home" });
      return;
    }
    const timer = setTimeout(() => {
      if (mode.kind === "search" && mode.query === query) return;
      const next: Mode = { kind: "search", query };
      setMode(next);
      load(next);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, mode, load, show]);

  const loadMore = useCallback(() => {
    if (!results?.next || loadingMore || mode.kind === "home") return;
    const page = results.next;
    const controller = new AbortController();
    listRequest.current = controller;
    setLoadingMore(true);
    const query =
      mode.kind === "genre" ? { topic: mode.genre.topic, page } : { search: mode.query, page };
    fetchCatalogue(query, controller.signal)
      .then((more) => {
        if (controller.signal.aborted) return;
        setResults((current) =>
          current
            ? { books: [...current.books, ...more.books], next: more.next, total: more.total }
            : more,
        );
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  }, [results, loadingMore, mode]);

  // The next page arrives as the reader nears the end of this one.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !results?.next) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [results, loadMore]);

  useEffect(() => () => listRequest.current?.abort(), []);

  /* ---------------- adding ---------------- */

  const open = useCallback((book: CatalogueBook) => {
    setSelected(book);
    setSummaryOpen(false);
    setAddError(null);
  }, []);

  const close = useCallback(() => {
    if (progress) return; // a download in flight has nowhere else to report
    setSelected(null);
  }, [progress]);

  /** Fetches and shelves the book; the account is told its title, as with
   *  any other book, and nothing more. */
  const add = useCallback(
    async (book: CatalogueBook): Promise<BookMeta | null> => {
      setAddError(null);
      setProgress({ stage: "reading", fraction: 0 });
      try {
        const meta = await addGutenbergBook(book, setProgress);
        setShelf((current) => new Map(current).set(book.id, meta));
        await ensureAccount();
        void pushBooks([meta]).catch(() => {});
        return meta;
      } catch (failure) {
        setAddError(describeImportError(failure));
        return null;
      } finally {
        setProgress(null);
      }
    },
    [ensureAccount],
  );

  const onListen = useCallback(
    async (book: CatalogueBook) => {
      const meta = shelf.get(book.id) ?? (await add(book));
      if (!meta) return;
      requestAutoplay(meta.id);
      router.push(`/read/${meta.id}`);
    },
    [shelf, add, router],
  );

  const onAdd = useCallback(
    async (book: CatalogueBook) => {
      const meta = await add(book);
      if (!meta) return;
      setToast({ id: Date.now(), text: `${book.title} is in your library` });
    },
    [add],
  );

  /* ---------------- render ---------------- */

  const heading = useMemo(() => {
    if (mode.kind === "genre") return mode.genre.label;
    if (mode.kind === "search") return `“${mode.query}”`;
    return null;
  }, [mode]);

  const owned = selected ? shelf.get(selected.id) : undefined;

  const tile = (book: CatalogueBook) => {
    const mine = shelf.has(book.id);
    return (
      <button
        type="button"
        className={styles.book}
        onClick={() => open(book)}
        aria-label={`${book.title}${book.author ? ` by ${book.author}` : ""}${mine ? ", in your library" : ""}`}
      >
        <span className={styles.bookCoverWrap} aria-hidden="true">
          <BookCover meta={coverMeta(book)} src={book.hasCover ? coverUrl(book.id) : undefined} />
          {mine && (
            <span className={styles.owned}>
              <CheckIcon size={13} />
            </span>
          )}
        </span>
        <span className={styles.bookTitle}>{book.title}</span>
        {book.author && <span className={styles.bookAuthor}>{book.author}</span>}
      </button>
    );
  };

  const ghosts = (n: number) =>
    Array.from({ length: n }, (_, i) => (
      <div key={i} className={styles.ghost} aria-hidden="true">
        <div className={styles.ghostCover} />
        <div className={styles.ghostLine} />
        <div className={styles.ghostLine} />
      </div>
    ));

  return (
    <main className={styles.page}>
      <header className={styles.head}>
        <div className={styles.headRow}>
          <Link href="/" className={styles.back} aria-label="Back to your library">
            <BackIcon size={20} />
          </Link>
          <span className={styles.eyebrow}>Project Gutenberg</span>
        </div>
        <div>
          <h1 className={styles.title}>Classics</h1>
          <p className={styles.lede}>
            The books that have outlived their copyright. Add one and it stays on this device, read
            aloud like everything else on your shelf.
          </p>
        </div>
        <div className={styles.search}>
          <SearchIcon size={17} className={styles.searchIcon} />
          <input
            className={styles.searchInput}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Title or author"
            aria-label="Search the library"
            autoComplete="off"
            enterKeyHint="search"
          />
          {search && (
            <button
              type="button"
              className={styles.searchClear}
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <CloseIcon size={15} />
            </button>
          )}
        </div>
      </header>

      {mode.kind === "home" ? (
        <>
          <section className={styles.section} aria-labelledby="popular-heading">
            <div className={styles.sectionHead}>
              <h2 id="popular-heading" className={styles.sectionLabel}>
                Most read
              </h2>
            </div>
            {popularError ? (
              <p className={styles.empty}>The library can&rsquo;t be reached right now.</p>
            ) : (
              <div className={styles.rail}>
                {popular ? popular.slice(0, 16).map((book) => <div key={book.id}>{tile(book)}</div>) : ghosts(5)}
              </div>
            )}
          </section>

          <section className={styles.section} aria-labelledby="genres-heading">
            <div className={styles.sectionHead}>
              <h2 id="genres-heading" className={styles.sectionLabel}>
                Browse by
              </h2>
            </div>
            <div className={styles.chips}>
              {GENRES.map((genre) => (
                <button
                  key={genre.topic}
                  type="button"
                  className={styles.chip}
                  aria-pressed="false"
                  onClick={() => show({ kind: "genre", genre })}
                >
                  {genre.label}
                </button>
              ))}
            </div>
          </section>

          <p className={styles.note}>
            Every book here is from{" "}
            <a href="https://www.gutenberg.org" target="_blank" rel="noreferrer">
              Project Gutenberg
            </a>
            , free to read and share. Aloud keeps the text on your device and nowhere else.
          </p>
        </>
      ) : (
        <section className={styles.section} aria-labelledby="results-heading">
          <div className={styles.sectionHead}>
            <h2 id="results-heading" className={styles.resultsTitle}>
              {heading}
              {results && (
                <>
                  {" "}
                  <span className={styles.sectionCount}>{formatCount(results.total)} books</span>
                </>
              )}
            </h2>
            <button type="button" className={styles.clear} onClick={() => show({ kind: "home" })}>
              Clear
            </button>
          </div>

          {mode.kind === "genre" && (
            <div className={styles.chips}>
              {GENRES.map((genre) => (
                <button
                  key={genre.topic}
                  type="button"
                  className={styles.chip}
                  aria-pressed={genre.topic === mode.genre.topic ? "true" : "false"}
                  onClick={() => show({ kind: "genre", genre })}
                >
                  {genre.label}
                </button>
              ))}
            </div>
          )}

          {listError ? (
            <div className={styles.errorCard} role="alert">
              <strong>The library can&rsquo;t be reached</strong>
              <p>{listError}</p>
              <button type="button" className={styles.retry} onClick={() => load(mode)}>
                Try again
              </button>
            </div>
          ) : loading ? (
            <div className={styles.grid}>{ghosts(8)}</div>
          ) : results && results.books.length === 0 ? (
            <p className={styles.empty}>Nothing by that name. Try the author&rsquo;s surname.</p>
          ) : (
            results && (
              <>
                <ul className={styles.grid}>
                  {results.books.map((book) => (
                    <li key={book.id}>{tile(book)}</li>
                  ))}
                </ul>
                {results.next && (
                  <>
                    <div ref={sentinel} className={styles.sentinel} aria-hidden="true" />
                    <button
                      type="button"
                      className={styles.more}
                      onClick={loadMore}
                      disabled={loadingMore}
                    >
                      {loadingMore ? "Loading" : "Show more"}
                    </button>
                  </>
                )}
              </>
            )
          )}
        </section>
      )}

      <Sheet open={selected !== null} title={owned ? "In your library" : "From Project Gutenberg"} onClose={close}>
        {selected && (
          <div className={styles.detail}>
            <div className={styles.detailTop}>
              <BookCover
                meta={coverMeta(selected)}
                size="lg"
                className={styles.detailCover}
                src={selected.hasCover ? coverUrl(selected.id) : undefined}
              />
              <div className={styles.detailText}>
                <h3 className={styles.detailTitle}>{selected.title}</h3>
                {selected.subtitle && <p className={styles.detailSubtitle}>{selected.subtitle}</p>}
                {selected.author && <p className={styles.detailAuthor}>{selected.author}</p>}
                {selected.subjects.length > 0 && (
                  <p className={styles.detailSubjects}>{selected.subjects.join(" · ")}</p>
                )}
              </div>
            </div>

            {selected.summary && (
              <>
                <p className={styles.summary} data-open={summaryOpen ? "true" : undefined}>
                  {selected.summary}
                </p>
                {!summaryOpen && selected.summary.length > 320 && (
                  <button
                    type="button"
                    className={styles.summaryMore}
                    onClick={() => setSummaryOpen(true)}
                  >
                    Read more
                  </button>
                )}
              </>
            )}

            {addError && (
              <div className={styles.errorCard} role="alert">
                <strong>{addError.title}</strong>
                <p>{addError.detail}</p>
              </div>
            )}

            {progress ? (
              <div className={styles.progressCard} role="status">
                <span className={styles.progressLabel}>{STAGE_TEXT[progress.stage]}</span>
                <div className={styles.progressTrack}>
                  <div
                    className={styles.progressFill}
                    style={{ transform: `scaleX(${Math.max(0.02, progress.fraction)})` }}
                  />
                </div>
              </div>
            ) : owned ? (
              <div className={styles.actions}>
                <Link href={`/read/${owned.id}`} className={styles.primary}>
                  <PlayIcon size={18} />
                  Open
                </Link>
                <span className={styles.ownedNote}>
                  <CheckIcon size={14} />
                  Already on this device
                </span>
              </div>
            ) : (
              <div className={styles.actions}>
                <button type="button" className={styles.primary} onClick={() => void onListen(selected)}>
                  <PlayIcon size={18} />
                  Listen now
                </button>
                <button type="button" className={styles.secondary} onClick={() => void onAdd(selected)}>
                  <PlusIcon size={16} />
                  Add to library
                </button>
              </div>
            )}
          </div>
        )}
      </Sheet>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </main>
  );
}
