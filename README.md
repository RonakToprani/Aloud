# Aloud

A read-along reader. Open a book, tap a word, and hear it read aloud with the
words lighting up as they're spoken. The book itself never leaves the device;
an optional account keeps everything else — your place, bookmarks, settings
and listening time — the same on every device you sign in to.

Built with Next.js on the App Router, deployed on Vercel, with Supabase for
auth and sync.

## How it works

**Speech comes from the browser.** `SpeechSynthesis` does the talking, behind a
`SpeechEngine` interface (`src/lib/speech/engine.ts`). Nothing above that
interface knows which engine is in use, so a self-hosted Piper server returning
audio plus word timestamps could be dropped in without the UI noticing.

**One sentence per utterance.** Chapters are split with `Intl.Segmenter` and
spoken a sentence at a time, chained on `onend`. Short utterances keep pause,
resume and seek reliable — Safari's `pause()` misbehaves on long ones — and give
the timing model a fresh calibration point every sentence.

**The highlight has two timing strategies, chosen at runtime.**
`src/lib/speech/synchronizer.ts` prefers real `boundary` events. If none arrive
within 400ms of `onstart`, it falls back to a timer that walks the words using
per-word duration estimates derived from word length, punctuation and the rate
setting. It switches in either direction mid-sentence: boundary events that dry
up hand over to the timer within 600ms, and a late boundary event takes control
straight back. Which strategy is live is decided from observed behaviour, never
from the user agent, and the reader should never see a stalled highlight.

**It corrects its own drift.** Each estimated sentence compares its predicted
duration against the real `onend` timestamp and folds the ratio into a per-voice
calibration factor kept in `localStorage`, so timing improves over the first few
sentences and stays good across sessions. Within a sentence, a mid-utterance
fallback anchors on the last boundary actually seen and takes its real/model
ratio from it, rather than assuming the current word has just started.

**Only the current sentence is rendered word by word.** Every sentence is a span
(needed for the sentence wash and for mapping taps), but word spans exist just
for the sentence being spoken. A novel stays cheap in the DOM while the
highlight still gets exact rectangles. Taps resolve to a word through
`caretRangeFromPoint`, so tapping works anywhere in the chapter.

**Highlights are drawn, not styled.** `HighlightLayer` paints measured
rectangles behind the text. Pill mode is a single element that moves and
resizes, so the eye follows one object rather than a strobe; it snaps rather
than glides across a line break. Wash mode is a pair that crossfades. Neither
occludes a letterform.

## Cloud voices, and why they sound continuous

Microsoft's Edge voices are synthesised on our own server route and come
back as MP3 plus word timings. Three things turn that into narration rather
than a queue of clips (`src/lib/speech/edge/`):

**Passages.** Sentences are sent together — 220 characters for the opening
so play feels instant, then 700, then 1500 — ending at paragraph breaks, so
the model shapes intonation across a paragraph instead of dropping to a full
stop after every sentence. The first sentence of a session waits for its
passage rather than playing as a clip of its own.

**Tightened silences.** Measured against the live endpoint, Edge leaves
950–1175ms of silence after every sentence and ~900ms at the end of each
clip. It refuses SSML that would shorten them, so `tighten.ts` shortens them
in the decoded audio: silent runs are found by RMS, sentence pauses are cut
to 380ms, paragraph pauses to 620ms, phrasing pauses under 450ms are left
alone, and the word timings are shifted to match. Splicing silence to
silence is inaudible.

**Sample-accurate seams.** The next passage is decoded while the current one
plays and scheduled on the audio clock to begin the instant the current one's
closing pause ends, so a passage boundary costs no JavaScript latency and
survives a backgrounded tab. Pausing drops the scheduled passage; resuming
re-times it.

`node scripts/measure-gap.mjs` records the schedule through the real player.

## Storage and sync

Local first, always. Parsed books live in IndexedDB; reading position, voice,
rate and appearance live in `localStorage`. The app works in full with no
network and no account.

On top of that sits the account (`src/lib/sync/`). Every visitor gets a quiet
anonymous Supabase session so their listening counts and their progress is
kept; signing in with a magic link (or the six-digit code from the same email,
for the home-screen app on iOS) turns it into a real account. What is stored:

- **Book metadata** — title, author, chapter titles and sentence counts. Never
  the text. A book the account knows about but this device has never held
  shows greyed in the library; tapping it asks for the same file again, and
  the saved place and bookmarks fit straight back onto it.
- **Reading positions** — written a couple of seconds after each sentence
  change, straight away on pause, and with a keepalive request as the page
  closes. Newest copy wins, judged by the writing device's own clock stamp
  with a 1.5s margin so two devices never bounce the reader back.
- **Bookmarks** — the union of both lists.
- **Settings** — one document on the profile, newest wins.
- **Listening time** — one row per reader visit, its running total replaced
  every 15s while playing. A trigger folds each write's delta into
  `reading_stats`, the single pre-aggregated row the home counter reads.
  "Listening right now" is a realtime presence channel.

### Setting up Supabase

1. Create a project and run `supabase/migrations/20260904000000_init.sql` in
   the SQL editor (or `supabase db push`).
2. Authentication › Providers: enable **Email** and **Anonymous sign-ins**.
   Google and Apple are optional: each needs its own OAuth credentials there
   (Google: an OAuth client in Google Cloud Console with the redirect URI
   `https://<project-ref>.supabase.co/auth/v1/callback`; Apple: a Services
   ID, key and team ID from the Apple Developer account). Then list the
   enabled ones in `NEXT_PUBLIC_AUTH_PROVIDERS` so their buttons appear.
3. Supabase's default magic-link email includes a six-digit code as well as
   the link. Set `NEXT_PUBLIC_SUPABASE_EMAIL_CODE=true` so the sign-in screen
   offers a code field: a reader on the home-screen app types the code
   instead of following a link that would open in Safari. If you later
   customise the template (custom SMTP required on the free tier), keep
   `{{ .Token }}` in it; `supabase/templates/magic_link.html` is a start.
4. Authentication › URL Configuration: add `https://<your-domain>/signin/done`
   (and `http://localhost:3000/signin/done`) to the redirect allow-list.
5. Copy `.env.example` to `.env.local` and fill in the URL and anon key; add
   the same two variables to the Vercel project.

Without the two variables the app runs exactly as before: local only, no
sign-in, no counter. EPUBs are unzipped with JSZip and the OPF spine is
walked directly, which gives cleaner control over extracting structured text
than rendering EPUB pages would. DRM is detected from `META-INF/encryption.xml`
— font obfuscation is ignored, encrypted spine documents are reported plainly.

## Development

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 56 tests: segmentation, timing, playback, EPUB, sync
npm run typecheck
npm run build
node scripts/screenshots.mjs   # renders every screen and theme (needs Chrome)
```

## Testing notes

The timing code is exercised against a fake engine that reproduces each real
failure mode: boundary events per word, no boundary events at all, events that
stop mid-sentence, synthesis that starts and dies, and Safari's instant silent
"end". See `tests/synchronizer.test.ts` and `tests/player.test.ts`.

**Still to verify on hardware:** everything above was tested under Node and in
desktop Chrome. iOS Safari — the primary target — has not been tested on a real
device. The two things to watch there are whether `boundary` events fire at all
for the chosen voice (the fallback should handle it either way), and whether
lock-screen controls appear; Media Session is wired up, but iOS may need a
silent looping `<audio>` element to hold the audio session, which is not
included because it risks interfering with speech and needs a device to judge.
