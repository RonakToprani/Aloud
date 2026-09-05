"use client";

import { getSupabase, keepaliveUpsert } from "@/lib/supabase/client";
import type { Settings } from "@/lib/storage/prefs";
import type { BookMeta, Bookmark, Position } from "@/lib/types";

/**
 * Everything the app stores on the account: library metadata, positions,
 * bookmarks, settings and listening time. Never book text.
 *
 * Every function here is safe to call when there is no account or no
 * network: it resolves to nothing and the app carries on from local
 * storage. Sync is a convenience layered over a local-first reader, not a
 * dependency of it.
 */

/** A book the account knows about that this device has no text for. */
export interface RemoteBook extends Omit<BookMeta, "cover"> {
  /** True when the parsed text is not in this device's IndexedDB. */
  missing: true;
}

interface BookRow {
  id: string;
  user_id: string;
  title: string;
  author: string | null;
  source: BookMeta["source"];
  added_at: string;
  sentence_count: number;
  word_count: number;
  chapter_titles: string[];
  chapter_sentence_counts: number[];
  chapter_word_counts: number[];
}

interface PositionRow {
  book_id: string;
  user_id: string;
  chapter_index: number;
  sentence_index: number;
  word_index: number;
  updated_at: string;
}

interface BookmarkRow {
  id: string;
  user_id: string;
  book_id: string;
  chapter_index: number;
  sentence_index: number;
  preview: string;
  chapter_title: string;
  created_at: string;
}

async function userId(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
}

const iso = (ms: number) => new Date(ms || Date.now()).toISOString();
const ms = (value: string | null | undefined) => (value ? Date.parse(value) || 0 : 0);

/* ---------------------------------------------------------------- books */

function toBookRow(meta: BookMeta, uid: string): BookRow {
  return {
    id: meta.id,
    user_id: uid,
    title: meta.title,
    author: meta.author,
    source: meta.source,
    added_at: iso(meta.addedAt),
    sentence_count: meta.sentenceCount,
    word_count: meta.wordCount,
    chapter_titles: meta.chapterTitles,
    chapter_sentence_counts: meta.chapterSentenceCounts,
    chapter_word_counts: meta.chapterWordCounts,
  };
}

function fromBookRow(row: BookRow): RemoteBook {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    source: row.source,
    addedAt: ms(row.added_at),
    sentenceCount: row.sentence_count,
    wordCount: row.word_count,
    chapterTitles: row.chapter_titles ?? [],
    chapterSentenceCounts: row.chapter_sentence_counts ?? [],
    chapterWordCounts: row.chapter_word_counts ?? [],
    missing: true,
  };
}

export async function pushBooks(metas: BookMeta[]): Promise<void> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid || !metas.length) return;
  await supabase.from("books").upsert(metas.map((meta) => toBookRow(meta, uid)), { onConflict: "id" });
}

export async function pullBooks(): Promise<RemoteBook[] | null> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid) return null;
  const { data, error } = await supabase.from("books").select("*").eq("user_id", uid);
  if (error || !data) return null;
  return (data as BookRow[]).map(fromBookRow);
}

export async function deleteRemoteBook(id: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase || !(await userId())) return;
  await supabase.from("books").delete().eq("id", id);
}

/* ---------------------------------------------------------------- positions */

function toPositionRow(bookId: string, position: Position, uid: string): PositionRow {
  return {
    book_id: bookId,
    user_id: uid,
    chapter_index: position.chapterIndex,
    sentence_index: position.sentenceIndex,
    word_index: position.wordIndex,
    updated_at: iso(position.updatedAt),
  };
}

function fromPositionRow(row: PositionRow): Position {
  return {
    chapterIndex: row.chapter_index,
    sentenceIndex: row.sentence_index,
    wordIndex: row.word_index,
    updatedAt: ms(row.updated_at),
  };
}

export async function pushPosition(bookId: string, position: Position): Promise<void> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid) return;
  await supabase
    .from("reading_positions")
    .upsert(toPositionRow(bookId, position, uid), { onConflict: "book_id" });
}

/** For the moment the page is closing, when a normal request would be lost. */
export function pushPositionNow(bookId: string, position: Position, uid: string | null): void {
  if (!uid) return;
  keepaliveUpsert("reading_positions", [toPositionRow(bookId, position, uid) as unknown as Record<string, unknown>]);
}

export async function pullPosition(bookId: string): Promise<Position | null> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid) return null;
  const { data } = await supabase
    .from("reading_positions")
    .select("*")
    .eq("book_id", bookId)
    .maybeSingle();
  return data ? fromPositionRow(data as PositionRow) : null;
}

export async function pullPositions(): Promise<Map<string, Position> | null> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid) return null;
  const { data, error } = await supabase.from("reading_positions").select("*").eq("user_id", uid);
  if (error || !data) return null;
  const map = new Map<string, Position>();
  for (const row of data as PositionRow[]) map.set(row.book_id, fromPositionRow(row));
  return map;
}

/* ---------------------------------------------------------------- bookmarks */

function toBookmarkRow(mark: Bookmark, uid: string): BookmarkRow {
  return {
    id: mark.id,
    user_id: uid,
    book_id: mark.bookId,
    chapter_index: mark.chapterIndex,
    sentence_index: mark.sentenceIndex,
    preview: mark.preview,
    chapter_title: mark.chapterTitle,
    created_at: iso(mark.createdAt),
  };
}

function fromBookmarkRow(row: BookmarkRow): Bookmark {
  return {
    id: row.id,
    bookId: row.book_id,
    chapterIndex: row.chapter_index,
    sentenceIndex: row.sentence_index,
    preview: row.preview,
    chapterTitle: row.chapter_title,
    createdAt: ms(row.created_at),
  };
}

export async function pushBookmarks(marks: Bookmark[]): Promise<void> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid || !marks.length) return;
  await supabase.from("bookmarks").upsert(marks.map((mark) => toBookmarkRow(mark, uid)), { onConflict: "id" });
}

export async function deleteRemoteBookmark(id: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase || !(await userId())) return;
  await supabase.from("bookmarks").delete().eq("id", id);
}

export async function pullBookmarks(bookId: string): Promise<Bookmark[] | null> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid) return null;
  const { data, error } = await supabase.from("bookmarks").select("*").eq("book_id", bookId);
  if (error || !data) return null;
  return (data as BookmarkRow[]).map(fromBookmarkRow);
}

/* ---------------------------------------------------------------- settings */

export async function pushSettings(settings: Settings): Promise<void> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid) return;
  await supabase
    .from("profiles")
    .upsert(
      { id: uid, settings, settings_updated_at: iso(settings.updatedAt) },
      { onConflict: "id" },
    );
}

export async function pullSettings(): Promise<{ settings: Partial<Settings>; updatedAt: number } | null> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid) return null;
  const { data } = await supabase
    .from("profiles")
    .select("settings, settings_updated_at")
    .eq("id", uid)
    .maybeSingle();
  if (!data || !data.settings_updated_at) return null;
  return {
    settings: (data.settings ?? {}) as Partial<Settings>,
    updatedAt: ms(data.settings_updated_at as string),
  };
}

/* ---------------------------------------------------------------- listening */

export interface ListeningSession {
  id: string;
  bookId: string | null;
  seconds: number;
  startedAt: number;
}

function toSessionRow(session: ListeningSession, uid: string): Record<string, unknown> {
  return {
    id: session.id,
    user_id: uid,
    book_id: session.bookId,
    seconds: Math.max(0, Math.min(86400, Math.round(session.seconds))),
    started_at: iso(session.startedAt),
  };
}

export async function pushListening(session: ListeningSession): Promise<void> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid || session.seconds < 1) return;
  await supabase.from("reading_sessions").upsert(toSessionRow(session, uid), { onConflict: "id" });
}

export function pushListeningNow(session: ListeningSession, uid: string | null): void {
  if (!uid || session.seconds < 1) return;
  keepaliveUpsert("reading_sessions", [toSessionRow(session, uid)]);
}

/** Seconds this account has listened in the last seven days, by day. */
export async function pullWeek(): Promise<number[] | null> {
  const supabase = getSupabase();
  const uid = await userId();
  if (!supabase || !uid) return null;
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("reading_sessions")
    .select("seconds, updated_at")
    .eq("user_id", uid)
    .gt("updated_at", since);
  if (error || !data) return null;
  const days = new Array<number>(7).fill(0);
  const now = Date.now();
  for (const row of data as { seconds: number; updated_at: string }[]) {
    const age = Math.floor((now - ms(row.updated_at)) / 86_400_000);
    if (age >= 0 && age < 7) days[6 - age] += row.seconds;
  }
  return days;
}
