"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSettings } from "@/components/SettingsProvider";
import { BackIcon } from "@/components/ui/Icons";
import { Toast, type ToastMessage } from "@/components/ui/Toast";
import { pickDefaultVoice, useSpeechEngine } from "@/lib/hooks/useSpeechEngine";
import { useMediaSession } from "@/lib/hooks/useMediaSession";
import { useWakeLock } from "@/lib/hooks/useWakeLock";
import { Player, type PlayerState } from "@/lib/player/player";
import { deleteBookmark, getBookBody, getBookMeta, listBookmarks, putBookmark } from "@/lib/storage/db";
import { loadPosition, savePosition } from "@/lib/storage/prefs";
import { segmentChapter, type SegmentedChapter } from "@/lib/text/segment";
import type { Bookmark, BookMeta, Chapter } from "@/lib/types";
import { AppearanceSheet } from "./AppearanceSheet";
import { ContentsSheet } from "./ContentsSheet";
import { ControlBar } from "./ControlBar";
import { PlaybackSheet } from "./PlaybackSheet";
import { ReaderSurface } from "./ReaderSurface";
import styles from "./ReaderView.module.css";

/** How long the chrome stays up after the last touch while reading. */
const CHROME_IDLE_MS = 3600;
/** Words per minute at 1× — refined by the reader's own speed setting. */
const BASE_WPM = 165;

type Sheet = "appearance" | "playback" | "contents" | null;

interface LoadedBook {
  meta: BookMeta;
  chapters: Chapter[];
}

export function ReaderView({ bookId }: { bookId: string }) {
  const { settings, update } = useSettings();
  const { engine, ready: voicesReady, supported, voices, preferredLang } = useSpeechEngine();

  const [book, setBook] = useState<LoadedBook | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);
  const [playerState, setPlayerState] = useState<PlayerState>({
    status: "idle",
    chapterIndex: 0,
    sentenceIndex: 0,
    wordIndex: 0,
    syncMode: "pending",
    error: null,
  });
  const [sheet, setSheet] = useState<Sheet>(null);
  const [chromeExpanded, setChromeExpanded] = useState(true);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [sleepMinutes, setSleepMinutes] = useState<number | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [sleepRemaining, setSleepRemaining] = useState<number | null>(null);

  const playerRef = useRef<Player | null>(null);
  const segmentCache = useRef(new Map<number, SegmentedChapter>());
  const stateRef = useRef(playerState);
  stateRef.current = playerState;

  const showToast = useCallback((text: string, action?: ToastMessage["action"]) => {
    setToast({ id: Date.now(), text, action });
  }, []);

  /* ---------------- loading ---------------- */

  useEffect(() => {
    let alive = true;
    const slowTimer = setTimeout(() => alive && setSlowLoad(true), 420);

    (async () => {
      try {
        const [meta, body] = await Promise.all([getBookMeta(bookId), getBookBody(bookId)]);
        if (!alive) return;
        if (!meta || !body) {
          setLoadError("That book isn't in your library any more. It may have been removed.");
          return;
        }
        setBook({ meta, chapters: body.chapters });
        setBookmarks(await listBookmarks(bookId).catch(() => []));
      } catch (error) {
        if (!alive) return;
        setLoadError(
          error instanceof Error
            ? error.message
            : "This book couldn't be opened from local storage.",
        );
      } finally {
        clearTimeout(slowTimer);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(slowTimer);
    };
  }, [bookId]);

  const getChapter = useCallback(
    (index: number): SegmentedChapter | undefined => {
      const chapter = book?.chapters[index];
      if (!chapter) return undefined;
      const cached = segmentCache.current.get(index);
      if (cached) return cached;
      const segmented = segmentChapter(chapter);
      segmentCache.current.set(index, segmented);
      return segmented;
    },
    [book],
  );

  /* ---------------- player ---------------- */

  useEffect(() => {
    if (!book) return;
    segmentCache.current.clear();

    const player = new Player({
      engine,
      getChapter,
      chapterCount: book.chapters.length,
      rate: settings.rate,
      voiceId: settings.voiceId,
      onState: setPlayerState,
      onSentence: (chapterIndex, sentenceIndex) => {
        savePosition(bookId, {
          chapterIndex,
          sentenceIndex,
          wordIndex: 0,
          updatedAt: Date.now(),
        });
      },
    });
    playerRef.current = player;

    const stored = loadPosition(bookId);
    if (stored) player.seek(stored.chapterIndex, stored.sentenceIndex, stored.wordIndex);
    else player.seek(0, 0, 0);

    return () => {
      player.destroy();
      playerRef.current = null;
    };
    // Rate and voice are pushed in below rather than rebuilding the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, engine, getChapter, bookId]);

  useEffect(() => {
    playerRef.current?.setRate(settings.rate);
  }, [settings.rate]);

  useEffect(() => {
    playerRef.current?.setVoice(settings.voiceId);
  }, [settings.voiceId]);

  // Choose a sensible voice the first time, and repair a stored choice this
  // device cannot actually speak — a voice carried over from another device,
  // or one iOS lists but reserves for Siri, which plays silently from a web
  // page and leaves the highlight parked on the first word.
  useEffect(() => {
    if (!voicesReady || !voices.length) return;
    const stored = settings.voiceId ? voices.find((v) => v.id === settings.voiceId) : undefined;
    const usable = stored && stored.tier !== "siri";
    if (settings.voiceId && usable) return;

    const preferred = pickDefaultVoice(voices, preferredLang);
    if (!preferred || preferred.id === settings.voiceId) return;
    update({ voiceId: preferred.id });
    if (settings.voiceId) {
      showToast(
        stored
          ? `${stored.name} can't be used by websites on this device — switched to ${preferred.name}.`
          : `That voice isn't on this device — switched to ${preferred.name}.`,
      );
    }
  }, [voicesReady, voices, settings.voiceId, preferredLang, update, showToast]);

  // Save the exact word when the reader leaves, locks the phone, or pauses.
  useEffect(() => {
    const persist = () => {
      const state = stateRef.current;
      savePosition(bookId, {
        chapterIndex: state.chapterIndex,
        sentenceIndex: state.sentenceIndex,
        wordIndex: state.wordIndex,
        updatedAt: Date.now(),
      });
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", persist);
    return () => {
      persist();
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", persist);
    };
  }, [bookId]);

  // The lock screen shows this, so it outlives any one sentence.
  useEffect(() => {
    const cover = book?.meta.cover;
    if (!cover) {
      setCoverUrl(null);
      return;
    }
    const url = URL.createObjectURL(cover);
    setCoverUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [book?.meta.cover]);

  const playing = playerState.status === "playing";
  useWakeLock(playing);

  /* ---------------- chrome ---------------- */

  const wakeChrome = useCallback(() => setChromeExpanded(true), []);

  useEffect(() => {
    if (!playing || sheet) {
      setChromeExpanded(true);
      return;
    }
    if (!chromeExpanded) return;
    const timer = setTimeout(() => setChromeExpanded(false), CHROME_IDLE_MS);
    return () => clearTimeout(timer);
  }, [playing, chromeExpanded, sheet, playerState.sentenceIndex]);

  /* ---------------- transport ---------------- */

  const onToggle = useCallback(() => {
    engine.unlock();
    wakeChrome();
    playerRef.current?.toggle();
  }, [engine, wakeChrome]);

  const onPrevious = useCallback(() => {
    wakeChrome();
    playerRef.current?.previousSentence();
  }, [wakeChrome]);

  const onNext = useCallback(() => {
    wakeChrome();
    playerRef.current?.nextSentence();
  }, [wakeChrome]);

  const onWordTap = useCallback(
    (sentenceIndex: number, wordIndex: number) => {
      engine.unlock();
      wakeChrome();
      playerRef.current?.playFrom(stateRef.current.chapterIndex, sentenceIndex, wordIndex);
    },
    [engine, wakeChrome],
  );

  const onChapter = useCallback((index: number) => {
    setSheet(null);
    playerRef.current?.goToChapter(index);
  }, []);

  /* ---------------- bookmarks ---------------- */

  const onSentenceHold = useCallback(
    async (sentenceIndex: number) => {
      if (!book) return;
      const chapterIndex = stateRef.current.chapterIndex;
      const chapter = getChapter(chapterIndex);
      const sentence = chapter?.sentences[sentenceIndex];
      if (!sentence) return;

      const existing = bookmarks.find(
        (mark) => mark.chapterIndex === chapterIndex && mark.sentenceIndex === sentenceIndex,
      );
      if (existing) {
        await deleteBookmark(existing.id).catch(() => {});
        setBookmarks((current) => current.filter((mark) => mark.id !== existing.id));
        showToast("Bookmark removed");
        return;
      }

      const mark: Bookmark = {
        id: `${chapterIndex}-${sentenceIndex}-${Date.now()}`,
        bookId,
        chapterIndex,
        sentenceIndex,
        preview: sentence.speakable.slice(0, 180),
        chapterTitle: book.meta.chapterTitles[chapterIndex] ?? `Chapter ${chapterIndex + 1}`,
        createdAt: Date.now(),
      };
      try {
        await putBookmark(mark);
        setBookmarks((current) => [...current, mark]);
        if (navigator.vibrate) navigator.vibrate(8);
        showToast("Bookmark added");
      } catch {
        showToast("That bookmark couldn't be saved on this device.");
      }
    },
    [book, bookId, bookmarks, getChapter, showToast],
  );

  const onDeleteBookmark = useCallback(
    async (id: string) => {
      const removed = bookmarks.find((mark) => mark.id === id);
      if (!removed) return;
      setBookmarks((current) => current.filter((mark) => mark.id !== id));
      await deleteBookmark(id).catch(() => {});
      showToast("Bookmark removed", {
        label: "Undo",
        onAction: () => {
          void putBookmark(removed).then(() =>
            setBookmarks((current) => [...current, removed]),
          );
        },
      });
    },
    [bookmarks, showToast],
  );

  /* ---------------- sleep timer ---------------- */

  useEffect(() => {
    if (sleepMinutes === null) {
      setSleepRemaining(null);
      return;
    }
    const endsAt = Date.now() + sleepMinutes * 60_000;
    setSleepRemaining(endsAt - Date.now());
    const tick = setInterval(() => {
      const remaining = endsAt - Date.now();
      if (remaining <= 0) {
        clearInterval(tick);
        setSleepMinutes(null);
        setSleepRemaining(null);
        playerRef.current?.pause();
        showToast("Sleep timer finished — your place is saved.");
        return;
      }
      setSleepRemaining(remaining);
    }, 1000);
    return () => clearInterval(tick);
  }, [sleepMinutes, showToast]);

  /* ---------------- keyboard ---------------- */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case " ":
          event.preventDefault();
          onToggle();
          break;
        case "ArrowRight":
          event.preventDefault();
          onNext();
          break;
        case "ArrowLeft":
          event.preventDefault();
          onPrevious();
          break;
        case "ArrowDown":
          event.preventDefault();
          update({ rate: Math.max(0.5, Math.round((settings.rate - 0.05) * 100) / 100) });
          break;
        case "ArrowUp":
          event.preventDefault();
          update({ rate: Math.min(2.5, Math.round((settings.rate + 0.05) * 100) / 100) });
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onToggle, onNext, onPrevious, settings.rate, update]);

  /* ---------------- derived ---------------- */

  const chapter = getChapter(playerState.chapterIndex);
  const meta = book?.meta;

  const progress = useMemo(() => {
    if (!meta || !meta.sentenceCount) return 0;
    let before = 0;
    for (let i = 0; i < playerState.chapterIndex; i++) before += meta.chapterSentenceCounts[i] ?? 0;
    return (before + playerState.sentenceIndex) / meta.sentenceCount;
  }, [meta, playerState.chapterIndex, playerState.sentenceIndex]);

  const minutesLeft = useMemo(() => {
    if (!meta || !chapter) return null;
    const chapterWords = meta.chapterWordCounts[playerState.chapterIndex] ?? 0;
    const sentences = chapter.sentences;
    let spoken = 0;
    for (let i = 0; i < playerState.sentenceIndex && i < sentences.length; i++) {
      spoken += sentences[i].words.length;
    }
    let remaining = Math.max(0, chapterWords - spoken);
    for (let i = playerState.chapterIndex + 1; i < meta.chapterWordCounts.length; i++) {
      remaining += meta.chapterWordCounts[i] ?? 0;
    }
    return remaining / (BASE_WPM * settings.rate);
  }, [meta, chapter, playerState.chapterIndex, playerState.sentenceIndex, settings.rate]);

  const bookmarkedInChapter = useMemo(() => {
    const set = new Set<number>();
    for (const mark of bookmarks) {
      if (mark.chapterIndex === playerState.chapterIndex) set.add(mark.sentenceIndex);
    }
    return set;
  }, [bookmarks, playerState.chapterIndex]);

  // Whole-book figures: a lock screen counting out the current sentence would
  // be useless, so this reports the book the way an audiobook would.
  const bookDurationSeconds = meta ? (meta.wordCount / (BASE_WPM * settings.rate)) * 60 : 0;
  const bookPositionSeconds =
    minutesLeft === null ? 0 : Math.max(0, bookDurationSeconds - minutesLeft * 60);

  useMediaSession(
    meta
      ? {
          title: meta.title,
          artist: meta.author ?? "Aloud",
          album: meta.chapterTitles[playerState.chapterIndex] ?? "",
          artwork: coverUrl,
          playing,
          durationSeconds: bookDurationSeconds,
          positionSeconds: bookPositionSeconds,
          playbackRate: settings.rate,
          onPlay: () => playerRef.current?.play(),
          onPause: () => playerRef.current?.pause(),
          onNext,
          onPrevious,
        }
      : null,
  );

  /* ---------------- render ---------------- */

  if (loadError) {
    return (
      <main className={styles.centered}>
        <div className={styles.notice}>
          <h1 className={styles.noticeTitle}>This book isn&rsquo;t here</h1>
          <p className={styles.noticeBody}>{loadError}</p>
          <Link className={styles.noticeAction} href="/">
            Back to your library
          </Link>
        </div>
      </main>
    );
  }

  if (!book || !chapter) {
    return (
      <main className={styles.centered}>
        {slowLoad && <p className={styles.quiet}>Opening {meta?.title ?? "your book"}…</p>}
      </main>
    );
  }

  const chapterTitle =
    book.meta.chapterTitles[playerState.chapterIndex] ?? `Chapter ${playerState.chapterIndex + 1}`;

  return (
    <>
      <header className={styles.top} data-hidden={chromeExpanded ? undefined : "true"}>
        <div className={styles.topInner}>
          <Link className={styles.back} href="/" aria-label="Back to library">
            <BackIcon />
          </Link>
          <div className={styles.crumb}>
            <span className={styles.crumbTitle}>{book.meta.title}</span>
            {/* A one-chapter book would otherwise print its title twice. */}
            {book.meta.chapterTitles.length > 1 && (
              <span className={styles.crumbChapter}>{chapterTitle}</span>
            )}
          </div>
        </div>
      </header>

      <main className={styles.main} onPointerDown={wakeChrome}>
        {!supported && (
          <div className={styles.banner}>
            <strong>This browser can&rsquo;t speak.</strong> It has no speech synthesis, so Aloud
            can only show the text. Safari, Chrome or Edge will read it aloud.
          </div>
        )}
        {supported && voicesReady && !voices.length && (
          <div className={styles.banner}>
            <strong>No voices are installed on this device.</strong> On iPhone and iPad, add one in
            Settings › Accessibility › Spoken Content › Voices, then come back.
          </div>
        )}
        {playerState.error && (
          <div className={styles.banner} role="alert">
            {playerState.error.message}
          </div>
        )}

        <ReaderSurface
          chapter={chapter}
          currentSentence={playerState.sentenceIndex}
          currentWord={playerState.wordIndex}
          highlight={settings.highlight}
          following={playing}
          onWordTap={onWordTap}
          onSentenceHold={onSentenceHold}
          bookmarkedSentences={bookmarkedInChapter}
        />

        {playerState.status === "ended" && (
          <div className={styles.finished}>
            <p className={styles.finishedTitle}>That&rsquo;s the end of {book.meta.title}.</p>
            <Link className={styles.noticeAction} href="/">
              Back to your library
            </Link>
          </div>
        )}
      </main>

      <ControlBar
        playing={playing}
        expanded={chromeExpanded}
        onExpand={wakeChrome}
        onToggle={onToggle}
        onPrevious={onPrevious}
        onNext={onNext}
        onAppearance={() => setSheet("appearance")}
        onPlayback={() => setSheet("playback")}
        onContents={() => setSheet("contents")}
        progress={progress}
        minutesLeft={minutesLeft}
        rate={settings.rate}
        sleepRemainingMs={sleepRemaining}
      />

      <AppearanceSheet
        open={sheet === "appearance"}
        onClose={() => setSheet(null)}
        settings={settings}
        update={update}
      />
      <PlaybackSheet
        open={sheet === "playback"}
        onClose={() => setSheet(null)}
        rate={settings.rate}
        onRate={(rate) => update({ rate })}
        voiceId={settings.voiceId}
        onVoice={(voiceId) => update({ voiceId })}
        voices={voices}
        preferredLang={preferredLang}
        voicesReady={voicesReady}
        sleepMinutes={sleepMinutes}
        sleepRemaining={sleepRemaining}
        onSleep={setSleepMinutes}
      />
      <ContentsSheet
        open={sheet === "contents"}
        onClose={() => setSheet(null)}
        chapterTitles={book.meta.chapterTitles}
        currentChapter={playerState.chapterIndex}
        onChapter={onChapter}
        bookmarks={bookmarks}
        onBookmark={(mark) => {
          setSheet(null);
          playerRef.current?.seek(mark.chapterIndex, mark.sentenceIndex, 0);
        }}
        onDeleteBookmark={onDeleteBookmark}
      />

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
