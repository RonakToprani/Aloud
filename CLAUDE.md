# Working on Aloud

A read-along reader: books read aloud with each word highlighted in time.
Next.js 15 App Router on Vercel, Supabase for auth and sync, TypeScript, CSS
Modules. No UI framework, no state library.

The README explains *what* the product is and how the reading engine works.
This file is the things that are expensive to rediscover and easy to break.

## Commands

```bash
npm run dev          # localhost:3000
npm test             # 116 tests, ~30s
npm run typecheck
npm run build
node scripts/pdfjs-assets.mjs # copy the pdf.js worker and data files into public/
node scripts/icons.mjs        # regenerate app icons from the logo geometry
node scripts/screenshots.mjs  # every screen and theme (needs Chrome)
node scripts/measure-gap.mjs  # how cloud audio is scheduled, through the real player
```

CI runs typecheck, tests and build on every push and PR. `main` is protected:
contributors need a PR plus a review, though the owner can push directly.

## Map

- `src/lib/speech/` — the `SpeechEngine` interface and its two implementations
  (device speech, cloud voices in `edge/`). Everything above this seam is
  engine-agnostic.
- `src/lib/player/player.ts` — playback, one sentence per utterance.
- `src/lib/speech/synchronizer.ts` — which word is lit, on two clocks.
- `src/lib/epub/parse.ts`, `src/lib/pdf/`, `src/lib/text/segment.ts` — books
  in, blocks and sentences out. `pdf/layout.ts` is the geometry, `pdf/parse.ts`
  the pdf.js side of it.
- `src/lib/storage/` — IndexedDB for book text, localStorage for settings and
  places.
- `src/lib/sync/` — the account layer. Never book text.
- `src/lib/library/` — import, the sample, progress, the autoplay handoff.
- `src/components/` — UI by screen. `reader/`, `library/`, `auth/`, `ui/`.
- `supabase/` — migrations and project config.

## Invariants

Things that look like they could be simplified and cannot.

**The speech seam.** Nothing above `SpeechEngine` may know which engine is
playing. A new engine returning audio plus word timings should drop in without
the reader changing.

**Two timing strategies.** `synchronizer.ts` uses real word-boundary events
when they arrive and a learned per-voice estimate when they do not, switching
mid-sentence in either direction. Both paths are load-bearing; some voices
never emit boundaries.

**Cloud audio is passages, not sentences.** Sentences are synthesised together
so intonation carries across a paragraph. The returned audio has about a
second of dead silence after every sentence, which `edge/tighten.ts` cuts down
to 380ms between sentences and 620ms between paragraphs, shifting the word
timings to match. The next passage is decoded early and scheduled on the audio
clock so seams cost nothing. Do not go back to one clip per sentence.

**The endpoint rejects SSML `<break>`.** Identical text returns 200 without it
and 502 with it. Pauses come from punctuation and from where passages end,
which is why passages end at paragraph breaks.

**A pause must stay paused.** The start-timeout watchdog, the stall recovery,
and any in-flight fetch all check the player is still meant to be playing
before making a sound. Three separate bugs lived here.

**`engine.cancel()` runs before every sentence,** including a normal advance,
which is why stopping the passage is deferred by a turn. Removing that
reintroduces a gap at every sentence.

**A PDF's paragraphs are inferred, not read.** A PDF stores glyphs at
coordinates and nothing about what a paragraph is, so `pdf/layout.ts` works
it back out: runs sharing a baseline are a line, and a line begins a new
paragraph on an indent, a blank line's worth of space, or a previous line
that stopped short of the right margin. Which of those to trust is decided
per document — a book that indents is never split on a short line, because
ragged-right text falls short of the margin on every line. Margins are
per column, so the second column of a paper is a margin and not one long
indent. Change a threshold here and check it against a real book, not only
the tests: `tests/pdfLayout.test.ts` states the geometry exactly, which is
the point, and cannot tell you what actual typesetting does. Measure it by
counting the pages of a real book that come out with none of their text in
any block; on a 900-page textbook that number should be the table of
contents and nothing else.

**Dropping a contents page is the rule most likely to eat a real one.** Half
a book's pages have numbers on them: axis labels, tables, numbered exercises.
So a page only goes if it has no prose on it at all *and* its numbers behave
like page numbers — inside this book's range, mostly distinct, going up as
the list goes down. Loosening any one of those cost about twenty pages of a
real textbook, silently. A page between two contents pages goes with them.

**A PDF costs about 350 MB of memory to read.** Measured on a 5.7 MB,
900-page textbook: peak 350 MB resident, 165 MB heap, about 3 seconds. Most
of it is pdf.js, not us — `doc.cleanup()` between pages was tried and
changed nothing. Pages are turned into lines as they are read rather than
held as text runs, which is the part that is ours to keep small.

**pdf.js ships as files, not as a bundle.** `scripts/pdfjs-assets.mjs` copies
the worker, the standard fonts and the CMaps into `public/pdfjs/<version>/`,
and `npm run dev`, `dev:local`, `build` and `start` all run it first. Every
bundler spells `new URL(..., import.meta.url)` differently and fails quietly:
the import resolves, the worker 404s, pdf.js silently parses on the main
thread, and a long book freezes the page. The version is in the path so the
service worker can cache it forever. `public/pdfjs/` is not committed.

**Design tokens are one ladder.** Every theme in `globals.css` is the same
lightness and chroma ladder with a different hue; the accent is a hue rotation
on top. Do not hand-pick per-theme colours, or 4 themes x 3 accents x 2
highlight styles stops being one product.

**Controls hide when the *reader* is idle,** not when the book advances. The
sentence index is deliberately absent from that effect's dependencies.

**Safari closes IndexedDB behind a backgrounded tab.** `storage/db.ts` retries
the open and reconnects on a stale handle. Without it, one failure poisons
every read for the life of the page.

## Backend

Supabase project ref `xkrhmqehytezexnotfxh`. Schema in `supabase/migrations/`,
applied with `supabase db push`; auth and provider settings live in
`supabase/config.toml` and go up with `supabase config push`.

Tables: `profiles` (settings), `books` (metadata only), `reading_positions`,
`bookmarks`, `reading_sessions`, `reading_stats` (one pre-aggregated row).
RLS on everything reader-owned; `reading_stats` is readable by anon.

**`books.source` is a check constraint,** so a new kind of book needs a
migration up before the deploy that can create one. A rejected row fails
silently on a fire-and-forget push, and that book's position and bookmarks
stop syncing with it. See `20260909000000_pdf_source.sql`.

**Book ids are global.** `books.id` and `reading_positions.book_id` are
primary keys across all users, so two users sharing an id means the second is
denied by RLS. This is why the sample mints a per-device id rather than using
one fixed id. Normal books use UUIDs, so it does not arise.

**Positions and sessions reference `books` by foreign key,** so a book must be
pushed to the account before anything can point at it. `ReaderView` pushes the
open book's metadata first for exactly this reason.

**The session delta trigger must be AFTER, not BEFORE.** An upsert fires
BEFORE INSERT with the whole value and then BEFORE UPDATE with the delta,
which double-counted every listening total. See
`20260906000000_session_delta_after.sql`.

**A reader is an account that has listened,** not an account that exists.
Anonymous sign-ins happen lazily, on the first book added or the first play,
so a visit that only looks around costs nothing and shared IPs do not hit the
per-hour anonymous cap.

**`reading_stats.baseline_seconds`** is added to the public total and is an
estimate of reading done before tracking existed. `public_stats()` also
returns `measured_seconds`, and `/api/stats` exposes both. Zero the baseline
with one UPDATE when it is no longer wanted.

## Client storage

localStorage, all prefixed `aloud.`:

| key | holds |
|---|---|
| `settings.v1` | theme, accent, highlight, size, leading, rate, voice |
| `position.<bookId>` | chapter, sentence, word, updatedAt |
| `stats.v1` | last known counter values, so the page never paints zeros |
| `remoteBooks.v1` | books the account knows about that this device lacks |
| `voiceChosen.v1` | books whose voice has been picked |
| `coach.v1` | walkthrough step: appearance / voice / done |
| `deviceOnly.v1` | the sign-up notice has been shown |
| `hasAccount.v1` | someone has signed in here, so the sign-in page greets them back |
| `sampleId.v1` | this device's copy of the sample |
| `homescreen.v1` | the add-to-home-screen step is done |
| `homescreenNote.v1` | the end-of-book home screen note has been waved away |
| `listened.v1` | seconds listened on this device |

`sessionStorage`: `aloud.autoplay` (one-shot request to start reading on
arrival), `aloud.presence` (presence channel key).

Every read and write is wrapped: private browsing throws on access, and the
app must work anyway.

## Environments

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_AUTH_PROVIDERS`, `NEXT_PUBLIC_SUPABASE_EMAIL_CODE`. Without the
first two the app runs local-only: no accounts, no counters, no sync. That
fallback is deliberate and worth preserving.

**Vercel preview variables are scoped per branch.** A new branch gets none,
so its preview silently runs local-only and the counters vanish. Add them when
you create the branch:

```bash
vercel env add NEXT_PUBLIC_SUPABASE_URL preview <branch> --value <url> --yes --force
```

Previews sit behind Vercel's login, so they cannot be fetched anonymously.

## Driving the app in a browser

Most bugs here are timing and only show in a real browser. `puppeteer-core` is
a dev dependency; Chrome is at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`. Launch with
`['--no-sandbox','--autoplay-policy=no-user-gesture-required','--mute-audio']`
and warm `/read/x` first so the route is compiled.

**Serve it with `npm run dev:local`, never `npm run dev`.** `.env.local`
points at the production Supabase project, and anonymous sign-ins happen on
the first book added or the first play, so a driven browser mints real
accounts and real listening time in the live database and the public counter
climbs. `dev:local` blanks the two Supabase variables, which the client reads
as unconfigured, so the run is local-only. Check before driving anything:

```bash
curl -s localhost:3000/api/stats   # {"error":"Stats aren't configured."}
```

Live numbers coming back from that means the app is talking to production.
Stop and restart with `dev:local`. Two rounds of testing put 41 fake readers
into the live count before this existed.

Selectors worth knowing:

- landing: the button whose text is exactly `Listen to a sample`
- reader controls: `button[aria-label="Pause" | "Play" | "Next sentence" |
  "Previous sentence" | "Appearance" | "Voice and speed" | "Contents"]`
- walkthrough sign: `[class*="hintStep"]` for the step label, and the two
  buttons whose text is exactly `Show me` and `Skip`. The body is a `<p>`, so
  clicking it does nothing
- the way back to the spoken line: `[class*="backToReading"]`
- floating sheet tip: `[class*="Sheet_tip"]`; toast: `[role="status"]`
- the highlight is drawn as measured rectangles, not styled spans, so there is
  no "current word" element to query

Headless Chrome has no device voices, so anything that has to actually speak
needs a cloud voice written into `settings.v1` before the page loads, plus
the book's id in `voiceChosen.v1`, or the first-run voice chooser sits in
front of the reader.

Adding a book without a file: click `Paste text`, then set the title input
(`input[placeholder*="article"]`) and the textarea by calling the native value
setter and dispatching an `input` event, then click `Add to library`.

Reset first-run state by clearing the `aloud.*` keys.

To watch audio scheduling, wrap `AudioContext.prototype.createBufferSource` in
`evaluateOnNewDocument` and log `start(when, offset)`; skip nodes with
`loop === true`, which are the silent keep-alive feed.

## Conventions

Comments explain **why**, never what. If a line looks wrong and isn't, say what
breaks without it.

User-facing copy: no em dashes, sentence case, plain words. It should read as
though a person wrote it for another person.

Commit messages are a short plain sentence about the change, present tense, no
attribution or tool references.

Verify with evidence rather than assertion. Run the tests, drive the browser,
read the screenshot. "Should work" is not a result.
