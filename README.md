# Aloud

A read-along reader. Open a book, tap a word, and hear it read aloud with the
words lighting up as they're spoken. Everything runs in the browser: no server,
no account, no data leaving the device.

Built with Next.js on the App Router, deployed on Vercel.

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

## Storage

Parsed books live in IndexedDB; reading position, voice, rate and appearance
live in `localStorage`. EPUBs are unzipped with JSZip and the OPF spine is
walked directly, which gives cleaner control over extracting structured text
than rendering EPUB pages would. DRM is detected from `META-INF/encryption.xml`
— font obfuscation is ignored, encrypted spine documents are reported plainly.

## Development

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 32 tests: segmentation, timing, playback, EPUB
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
