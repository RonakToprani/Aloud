"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useSettings } from "@/components/SettingsProvider";
import { BackIcon } from "@/components/ui/Icons";
import { Toast, type ToastMessage } from "@/components/ui/Toast";
import { pickDefaultVoice, pickShowcaseVoice, useSpeechEngine } from "@/lib/hooks/useSpeechEngine";
import { useMediaSession } from "@/lib/hooks/useMediaSession";
import { useVoicePreview, voiceIntro } from "@/lib/hooks/useVoicePreview";
import { useWakeLock } from "@/lib/hooks/useWakeLock";
import { Player, type PlayerState } from "@/lib/player/player";
import { peekAutoplay, takeAutoplay } from "@/lib/library/autoplay";
import { bookFraction } from "@/lib/library/progress";
import { deleteBookmark, getBookBody, getBookMeta, listBookmarks, putBookmark } from "@/lib/storage/db";
import { hasChosenVoice, loadPosition, markVoiceChosen, savePosition } from "@/lib/storage/prefs";
import { useListeningClock } from "@/lib/sync/listening";
import {
  deleteRemoteBookmark,
  pullBookmarks,
  pullPosition,
  pushBookmarks,
  pushBooks,
  pushPosition,
  pushPositionNow,
} from "@/lib/sync/remote";
import { segmentChapter, type SegmentedChapter } from "@/lib/text/segment";
import type { Bookmark, BookMeta, Chapter, Position } from "@/lib/types";
import { AppearanceSheet } from "./AppearanceSheet";
import { ContentsSheet } from "./ContentsSheet";
import { ControlBar, type ControlHint } from "./ControlBar";
import { PlaybackSheet } from "./PlaybackSheet";
import { ReaderSurface } from "./ReaderSurface";
import { VoiceChooser } from "./VoiceChooser";
import { HomeScreenNote } from "@/components/install/HomeScreenNote";
import styles from "./ReaderView.module.css";

/**
 * A three-step walk through the two settings that decide whether someone
 * stays: how the page looks, and who reads it.
 *
 * Each sign waits to be tapped rather than timing out, because a pointer
 * that vanishes while you are reading the sentence under it has taught
 * nobody anything. Tapping opens what it points at, and the next sign
 * appears once that is closed. Shown once, then never again.
 *
 * The page dims behind a sign and the control it names is lit. Without that
 * it read as one more thing in the way, and skipping was the fastest way
 * back to the book.
 */
const COACH_KEY = "aloud.coach.v1";
type CoachStep = "appearance" | "voice" | "done";
/** Reading time before the first sign, so it lands after the voice has settled. */
const COACH_AFTER_MS = 5000;
/** A reader who never presses play still gets shown around, just later: the
 *  walkthrough is the only thing that explains the two controls that matter. */
const COACH_WAIT_MS = 14000;
const COACH_TICK_MS = 500;

const COACH_TEXT: Record<"appearance" | "voice", string> = {
  appearance: "Reading is easier when the page suits you. Set the text size, spacing and colour here.",
  voice: "The voice is the thing you will hear for hours. Pick one you like, and the speed to match.",
};

/** Said once inside each sheet, floating over it, then gone. */
const COACH_SHEET_TEXT = {
  appearance:
    "Pick a theme, then set the size and spacing. Everything changes behind the sheet as you go.",
  voice:
    "Tap a speaker to hear that voice, then its name to keep it. Speed is at the top.",
};

function storedCoachStep(): CoachStep {
  try {
    const raw = localStorage.getItem(COACH_KEY);
    return raw === "voice" || raw === "done" ? raw : "appearance";
  } catch {
    return "done"; // no memory of it means never starting it
  }
}

function rememberCoachStep(step: CoachStep): void {
  try {
    localStorage.setItem(COACH_KEY, step);
  } catch {
    /* it simply offers again next time */
  }
}

/** How long the chrome stays up after the last touch while reading. */
const CHROME_IDLE_MS = 3600;
/** Words per minute at 1× — refined by the reader's own speed setting. */
const BASE_WPM = 165;
/** How long after the last sentence change the account is told where the
 *  reader is. Pausing and leaving write straight away. */
const POSITION_PUSH_MS = 2500;
/** A position from another device only wins by a clear margin, so two
 *  devices' clocks disagreeing by a second never bounces the reader back. */
const POSITION_SLACK_MS = 1500;

type Sheet = "appearance" | "playback" | "contents" | null;

interface LoadedBook {
  meta: BookMeta;
  chapters: Chapter[];
}

/**
 * A saved place only means something on the copy of the book it was saved
 * in. A re-added file that segments differently, or a different edition,
 * can put the place past the end of a chapter or in a chapter that isn't
 * there; rather than land at a random spot (or the last sentence, which
 * reads as "finished"), fall back to the start of the nearest chapter.
 */
function fitPosition(position: Position, meta: BookMeta): Position | null {
  const chapters = meta.chapterSentenceCounts.length;
  if (!chapters) return null;
  if (position.chapterIndex < 0 || position.chapterIndex >= chapters) {
    return { ...position, chapterIndex: Math.min(Math.max(0, position.chapterIndex), chapters - 1), sentenceIndex: 0, wordIndex: 0 };
  }
  const sentences = meta.chapterSentenceCounts[position.chapterIndex] ?? 0;
  if (position.sentenceIndex < 0 || position.sentenceIndex >= sentences) {
    return { ...position, sentenceIndex: 0, wordIndex: 0 };
  }
  return position;
}

export function ReaderView({ bookId }: { bookId: string }) {
  const { settings, update } = useSettings();
  const { engine, ready: voicesReady, supported, voices, preferredLang } = useSpeechEngine();
  const { status: authStatus, userId, epoch: authEpoch, ensureAccount } = useAuth();

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
  /** True until this book has a saved place: its first opening on this device
   *  begins by choosing the voice that will read it. */
  const [needsVoice, setNeedsVoice] = useState(false);
  /** Set when the reader arrived here expecting the book to start itself. */
  const [autoplay, setAutoplay] = useState(false);
  /** Which sign is due, or null before the walkthrough has begun. */
  const [coachStep, setCoachStep] = useState<CoachStep | null>(null);
  /** Which sheet the walkthrough has just opened, if any. */
  const [coachNote, setCoachNote] = useState<"appearance" | "voice" | null>(null);
  /** Reading time, in ms, with nothing open over the top of it. */
  const coachClock = useRef(0);
  const coachWait = useRef(0);
  const finishedRef = useRef<HTMLDivElement>(null);
  /** Where another device left off, if newer than this one. */
  const [remotePosition, setRemotePosition] = useState<Position | null>(null);

  const playerRef = useRef<Player | null>(null);
  const segmentCache = useRef(new Map<number, SegmentedChapter>());
  const stateRef = useRef(playerState);
  stateRef.current = playerState;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Nothing about the reader's place is written until the book is open. */
  const loaded = useRef(false);

  const showToast = useCallback((text: string, action?: ToastMessage["action"]) => {
    setToast({ id: Date.now(), text, action });
  }, []);

  // Arriving to play: claim the audio session straight away, while the tap
  // that navigated here still counts as a gesture. Waiting until the book
  // has been read out of storage can miss that window on iOS.
  useEffect(() => {
    if (peekAutoplay(bookId)) engine.unlock();
  }, [bookId, engine]);

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
        // A first opening asks for a voice; a book already under way, or one
        // whose voice was chosen before, goes straight to the text.
        const stored = loadPosition(bookId);
        const underway = !!stored && (stored.chapterIndex > 0 || stored.sentenceIndex > 0 || stored.wordIndex > 0);
        // Arriving from the sample: the point was to hear it, so the voice
        // question waits until the reader has a reason to care about it.
        const wantsAutoplay = takeAutoplay(bookId);
        if (wantsAutoplay) markVoiceChosen(bookId);
        setAutoplay(wantsAutoplay);
        setNeedsVoice(!wantsAutoplay && !underway && !hasChosenVoice(bookId));
        loaded.current = true;
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

  /* ---------------- account ---------------- */

  // Ask the account where this book was left and which sentences were kept,
  // then settle both ways: a newer place from another device is adopted, a
  // newer one here is sent up; bookmarks are the union of the two lists.
  useEffect(() => {
    if (!book || !userId) return;
    let alive = true;
    (async () => {
      // The account has to know the book before anything can point at it:
      // positions and listening sessions are keyed to it, and a write for a
      // book the account has never seen is rejected. This also refreshes
      // metadata for a book re-imported with better chapter detection.
      await pushBooks([book.meta]).catch(() => {});
      if (!alive) return;
      const [theirs, remoteMarks] = await Promise.all([
        pullPosition(bookId).catch(() => null),
        pullBookmarks(bookId).catch(() => null),
      ]);
      if (!alive) return;

      const mine = loadPosition(bookId);
      if (theirs && (!mine || theirs.updatedAt > mine.updatedAt + POSITION_SLACK_MS)) {
        setRemotePosition(theirs);
      } else if (mine && (!theirs || mine.updatedAt > theirs.updatedAt)) {
        void pushPosition(bookId, mine).catch(() => {});
      }

      if (remoteMarks) {
        const local = await listBookmarks(bookId).catch(() => [] as Bookmark[]);
        if (!alive) return;
        const localIds = new Set(local.map((mark) => mark.id));
        const remoteIds = new Set(remoteMarks.map((mark) => mark.id));
        const arrived = remoteMarks.filter((mark) => !localIds.has(mark.id));
        const departed = local.filter((mark) => !remoteIds.has(mark.id));
        await Promise.all(arrived.map((mark) => putBookmark(mark).catch(() => {})));
        if (departed.length) void pushBookmarks(departed).catch(() => {});
        if (arrived.length) setBookmarks([...local, ...arrived]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [book, bookId, userId, authEpoch]);

  // A newer place from another device moves the cursor — but only while
  // nothing is playing here, and never once the reader has started.
  useEffect(() => {
    if (!remotePosition || !playerRef.current || !book) return;
    if (stateRef.current.status === "playing") return;
    const fit = fitPosition(remotePosition, book.meta);
    if (!fit) {
      setRemotePosition(null);
      return;
    }
    playerRef.current.seek(fit.chapterIndex, fit.sentenceIndex, fit.wordIndex);
    savePosition(bookId, remotePosition);
    setRemotePosition(null);
    showToast("Picked up where you left off on another device.");
  }, [remotePosition, bookId, book, showToast]);

  const schedulePush = useCallback((chapterIndex: number, sentenceIndex: number, wordIndex: number) => {
    if (!userIdRef.current) return;
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      pushTimer.current = null;
      void pushPosition(bookId, { chapterIndex, sentenceIndex, wordIndex, updatedAt: Date.now() }).catch(() => {});
    }, POSITION_PUSH_MS);
  }, [bookId]);

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
        schedulePush(chapterIndex, sentenceIndex, 0);
      },
    });
    playerRef.current = player;

    const stored = loadPosition(bookId);
    const fit = stored ? fitPosition(stored, book.meta) : null;
    if (fit) {
      player.seek(fit.chapterIndex, fit.sentenceIndex, fit.wordIndex);
      if (stored && fit.sentenceIndex !== stored.sentenceIndex) {
        showToast("This copy is laid out differently, so the chapter starts over.");
      }
    } else {
      player.seek(0, 0, 0);
    }

    return () => {
      player.destroy();
      playerRef.current = null;
    };
    // Rate and voice are pushed in below rather than rebuilding the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, engine, getChapter, bookId]);

  // Declared after the player exists, so playerRef is populated by now.
  useEffect(() => {
    if (!autoplay || !book || !voicesReady || !settings.voiceId) return;
    const player = playerRef.current;
    if (!player) return;
    setAutoplay(false);
    // Still inside the activation from the tap that navigated here, so iOS
    // allows this; where it does not, the play button is already on screen.
    engine.unlock();
    player.play();
  }, [autoplay, book, voicesReady, settings.voiceId, engine]);

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

    // Never chosen a voice before: this is the first thing they will hear,
    // so lead with one built for reading books. A stored voice this device
    // cannot speak is a repair, and takes the ordinary default.
    const preferred = settings.voiceId
      ? pickDefaultVoice(voices, preferredLang)
      : pickShowcaseVoice(voices, preferredLang);
    if (!preferred || preferred.id === settings.voiceId) return;
    update({ voiceId: preferred.id });
    if (settings.voiceId) {
      showToast(
        stored
          ? `${stored.name} can't be used by websites on this device, so ${preferred.name} is reading instead.`
          : `That voice isn't on this device, so ${preferred.name} is reading instead.`,
      );
    }
  }, [voicesReady, voices, settings.voiceId, preferredLang, update, showToast]);

  // Save the exact word when the reader leaves, locks the phone, or pauses —
  // here, and on the account with a request that survives the page closing.
  useEffect(() => {
    const persist = () => {
      if (!loaded.current) return;
      const state = stateRef.current;
      const position = {
        chapterIndex: state.chapterIndex,
        sentenceIndex: state.sentenceIndex,
        wordIndex: state.wordIndex,
        updatedAt: Date.now(),
      };
      savePosition(bookId, position);
      if (pushTimer.current) {
        clearTimeout(pushTimer.current);
        pushTimer.current = null;
      }
      pushPositionNow(bookId, position, userIdRef.current);
    };
    window.addEventListener("pagehide", persist);
    document.addEventListener("visibilitychange", persist);
    return () => {
      persist();
      window.removeEventListener("pagehide", persist);
      document.removeEventListener("visibilitychange", persist);
    };
  }, [bookId]);

  // Pausing is the moment a reader is most likely to pick up another
  // device, so the exact word goes up straight away.
  useEffect(() => {
    if (playerState.status !== "paused" || !userId) return;
    if (pushTimer.current) {
      clearTimeout(pushTimer.current);
      pushTimer.current = null;
    }
    const state = stateRef.current;
    void pushPosition(bookId, {
      chapterIndex: state.chapterIndex,
      sentenceIndex: state.sentenceIndex,
      wordIndex: state.wordIndex,
      updatedAt: Date.now(),
    }).catch(() => {});
  }, [playerState.status, bookId, userId]);

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
  useEffect(() => {
    if (playing) void ensureAccount();
  }, [playing, ensureAccount]);
  useListeningClock(playing, bookId, userId);

  /* ---------------- voice preview ---------------- */

  const { previewing, preview, stop: stopPreview } = useVoicePreview(engine, settings.rate);

  // Each voice auditions by introducing itself, so the reader hears the
  // voice rather than a passage they were about to hear anyway.
  const onPreview = useCallback(
    (voiceId: string) => {
      playerRef.current?.pause();
      const voice = voices.find((v) => v.id === voiceId);
      preview(voiceId, voiceIntro(voice?.name ?? ""));
    },
    [preview, voices],
  );

  const onStartWithVoice = useCallback(() => {
    stopPreview();
    engine.unlock();
    markVoiceChosen(bookId);
    setNeedsVoice(false);
    playerRef.current?.play();
  }, [engine, stopPreview, bookId]);

  // The end of a book arrives below the last line of it, under the controls.
  // Bring it into view, or the reader is left staring at a page that simply
  // stopped.
  useEffect(() => {
    if (playerState.status !== "ended") return;
    const timer = setTimeout(
      () => finishedRef.current?.scrollIntoView({ block: "center", behavior: "smooth" }),
      140,
    );
    return () => clearTimeout(timer);
  }, [playerState.status]);

  /* ---------------- first-time pointers ---------------- */

  useEffect(() => {
    const stored = storedCoachStep();
    if (stored !== "done") setCoachStep(null); // begins once there is reading behind it
  }, []);

  // Paced by time actually spent reading, so a reader who pauses to look at
  // something has not missed their turn. Time on the screen counts too, more
  // slowly, or a reader who never starts the voice is never shown anything.
  useEffect(() => {
    if (sheet || coachStep) return;
    if (needsVoice) return; // the voice chooser owns the screen, and covers the dock
    if (playerState.status === "ended") return; // nothing left to point at
    if (storedCoachStep() === "done") return;
    const timer = setInterval(() => {
      if (playing) coachClock.current += COACH_TICK_MS;
      coachWait.current += COACH_TICK_MS;
      if (coachClock.current >= COACH_AFTER_MS || coachWait.current >= COACH_WAIT_MS) {
        setCoachStep(storedCoachStep());
      }
    }, COACH_TICK_MS);
    return () => clearInterval(timer);
  }, [playing, sheet, coachStep, needsVoice, playerState.status]);

  /** Tapping a sign opens what it points at and arms the next one. */
  const onCoach = useCallback((at: ControlHint["at"]) => {
    if (at === "appearance") {
      rememberCoachStep("voice");
      setCoachStep("voice");
      setCoachNote("appearance");
      setSheet("appearance");
    } else {
      rememberCoachStep("done");
      setCoachStep("done");
      setCoachNote("voice");
      setSheet("playback");
    }
  }, []);

  const onCoachDismiss = useCallback(() => {
    rememberCoachStep("done");
    setCoachStep("done");
  }, []);

  // Finding a control unaided counts, and counts even before its sign has
  // appeared: a reader who already opened Appearance must not be told about
  // it five seconds later. The stored step advances either way; the visible
  // step only moves if a sign was actually on screen, so the next one is
  // still paced rather than appearing the instant a sheet closes.
  useEffect(() => {
    if (!sheet) {
      setCoachNote(null);
      return;
    }
    const stored = storedCoachStep();
    if (sheet === "appearance" && stored === "appearance") {
      rememberCoachStep("voice");
      setCoachStep((current) => (current ? "voice" : current));
      setCoachNote("appearance");
    }
    if (sheet === "playback" && stored === "voice") {
      rememberCoachStep("done");
      setCoachStep((current) => (current ? "done" : current));
      setCoachNote("voice");
    }
  }, [sheet, coachStep]);

  /** The sign on screen right now, if any. A sheet hides it. */
  const coachHint: ControlHint | null =
    sheet ||
    needsVoice ||
    // A sign left standing at the end dims the one thing left to do.
    playerState.status === "ended" ||
    coachStep === null ||
    coachStep === "done"
      ? null
      : coachStep === "appearance"
        ? { at: "appearance", text: COACH_TEXT.appearance, step: 1, of: 2 }
        : { at: "playback", text: COACH_TEXT.voice, step: 2, of: 2 };

  /* ---------------- chrome ---------------- */

  const wakeChrome = useCallback(() => setChromeExpanded(true), []);

  useEffect(() => {
    // A sign pointing at a hidden control points at nothing.
    if (!playing || sheet || coachHint) {
      setChromeExpanded(true);
      return;
    }
    if (!chromeExpanded) return;
    const timer = setTimeout(() => setChromeExpanded(false), CHROME_IDLE_MS);
    return () => clearTimeout(timer);
    // Deliberately not restarted by the sentence advancing. The controls
    // hide when the *reader* has been idle, and a sentence turning over is
    // the book working, not a touch: with sentences shorter than the timeout
    // the countdown never finished and the chrome never withdrew.
  }, [playing, chromeExpanded, sheet, coachHint]);

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
        void deleteRemoteBookmark(existing.id).catch(() => {});
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
        void pushBookmarks([mark]).catch(() => {});
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
      void deleteRemoteBookmark(id).catch(() => {});
      showToast("Bookmark removed", {
        label: "Undo",
        onAction: () => {
          void putBookmark(removed).then(() => {
            setBookmarks((current) => [...current, removed]);
            void pushBookmarks([removed]).catch(() => {});
          });
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
        showToast("Sleep timer finished. Your place is saved.");
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
      if (needsVoice) return;

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
  }, [onToggle, onNext, onPrevious, settings.rate, update, needsVoice]);

  /* ---------------- derived ---------------- */

  const chapter = getChapter(playerState.chapterIndex);
  const meta = book?.meta;

  const progress = useMemo(
    () => (meta ? bookFraction(meta, playerState.chapterIndex, playerState.sentenceIndex) : 0),
    [meta, playerState.chapterIndex, playerState.sentenceIndex],
  );

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

  const chooseVoice = needsVoice && supported && voicesReady && voices.length > 0;
  // The sample carries a per-device id of its own; see lib/library/sample.
  const isSample = book.meta.id.startsWith("sample-");

  return (
    <>
      {chooseVoice && (
        <VoiceChooser
          bookTitle={book.meta.title}
          voices={voices}
          preferredLang={preferredLang}
          ready={voicesReady}
          voiceId={settings.voiceId}
          onVoice={(voiceId) => update({ voiceId })}
          previewing={previewing}
          onPreview={onPreview}
          onStart={onStartWithVoice}
        />
      )}

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
          controlsExpanded={chromeExpanded}
          hintShowing={coachHint !== null}
          onWordTap={onWordTap}
          onSentenceHold={onSentenceHold}
          bookmarkedSentences={bookmarkedInChapter}
        />

        {playerState.status === "ended" && (
          <div className={styles.finished} ref={finishedRef}>
            <p className={styles.finishedTitle}>
              {isSample ? "That\u2019s the end of the sample." : `That\u2019s the end of ${book.meta.title}.`}
            </p>
            {isSample && (
              <p className={styles.finishedBody}>
                Add a book of your own and it will be read to you the same way.
              </p>
            )}
            {/* The end of a book is when someone knows whether they want it on
                their phone, so the offer is made here rather than buried in
                sign-up, where a first-time reader has not heard it read yet. */}
            <HomeScreenNote />
            <Link className={styles.noticeAction} href="/">
              {isSample ? "Add a book" : "Back to your library"}
            </Link>
            {authStatus !== "unavailable" && authStatus !== "signed-in" && (
              <Link className={styles.finishedSignIn} href="/signin" prefetch={false}>
                Sign in to keep your place on every device
              </Link>
            )}
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
        // A book that has ended has nothing left to count down.
        minutesLeft={playerState.status === "ended" ? null : minutesLeft}
        rate={settings.rate}
        sleepRemainingMs={sleepRemaining}
        hint={coachHint}
        onHint={onCoach}
        onHintDismiss={onCoachDismiss}
      />

      <AppearanceSheet
        open={sheet === "appearance"}
        onClose={() => setSheet(null)}
        settings={settings}
        update={update}
        tip={coachNote === "appearance" ? COACH_SHEET_TEXT.appearance : null}
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
        tip={coachNote === "voice" ? COACH_SHEET_TEXT.voice : null}
        previewing={previewing}
        onPreview={onPreview}
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
