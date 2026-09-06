# Working on Aloud

A read-along reader: books read aloud with each word highlighted in time.
Next.js 15 App Router on Vercel, Supabase for auth and sync, TypeScript, CSS
Modules. No UI framework, no state library.

The README explains *what* the product is and how the reading engine works.
This file is the things that are expensive to rediscover and easy to break.

## Commands

```bash
npm run dev          # localhost:3000
npm test             # 80 tests, ~30s
npm run typecheck
npm run build
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
- `src/lib/epub/parse.ts`, `src/lib/text/segment.ts` — books in, blocks and
  sentences out.
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

Selectors worth knowing:

- landing: the button whose text is exactly `Listen to a sample`
- reader controls: `button[aria-label="Pause" | "Play" | "Next sentence" |
  "Previous sentence" | "Appearance" | "Voice and speed" | "Contents"]`
- walkthrough sign: `[class*="hintBody"]`; floating sheet tip:
  `[class*="Sheet_tip"]`; toast: `[role="status"]`
- the highlight is drawn as measured rectangles, not styled spans, so there is
  no "current word" element to query

Adding a book without a file: click `Paste text`, then set the title input
(`input[placeholder*="article"]`) and the textarea by calling the native value
setter and dispatching an `input` event, then click `Add to library`.

Reset first-run state by clearing the `aloud.*` keys. Force a cloud voice by
writing `settings.v1` with `voiceId: "edge:en-US-AriaNeural"` before loading.

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
