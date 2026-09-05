<p align="center">
  <img src="public/icons/icon-192.png" width="88" alt="" />
</p>

<h1 align="center">Aloud</h1>

<p align="center">
  Bring your own books. Press play, and every word lights up as it's spoken.
</p>

<p align="center">
  <a href="https://aloud-red.vercel.app"><img alt="Open Aloud" src="https://img.shields.io/badge/open-aloud--red.vercel.app-5b7fa6?style=flat-square" /></a>
  <img alt="Hours listened" src="https://img.shields.io/badge/dynamic/json?style=flat-square&color=6a8fb5&label=hours%20listened&query=%24.hours_listened_label&url=https%3A%2F%2Faloud-red.vercel.app%2Fapi%2Fstats" />
  <img alt="Readers" src="https://img.shields.io/badge/dynamic/json?style=flat-square&color=6a8fb5&label=readers&query=%24.readers&url=https%3A%2F%2Faloud-red.vercel.app%2Fapi%2Fstats" />
  <img alt="Active this week" src="https://img.shields.io/badge/dynamic/json?style=flat-square&color=6a8fb5&label=active%20this%20week&query=%24.active_readers_7d&url=https%3A%2F%2Faloud-red.vercel.app%2Fapi%2Fstats" />
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-8b8f99?style=flat-square" /></a>
</p>

Aloud is a read-along reader for the web. Add an EPUB, a text file, or paste
anything, and it reads to you with a real voice while the sentence and the
word being spoken light up on the page. It's a personal library: the books
you bring, nothing else. No store, no feed, no social layer.

It's built for a phone, one-handed, often at night. Save it to the home
screen and it opens full-screen, keeps reading with the screen locked, and
puts play and pause on the lock screen.

**Try it:** [aloud-red.vercel.app](https://aloud-red.vercel.app). Reading
works without an account; sign in to keep your library and your place in it
on every device.

## What it does

- **Reads any book you own.** EPUB and plain text. Books stay on your device;
  the text is never uploaded anywhere.
- **Lights every word.** A single pill glides from word to word as it's
  spoken, with the current sentence washed behind it. Tap any word to start
  reading from there. Hold a sentence to bookmark it.
- **Sounds like narration.** Sentences are synthesised together as passages
  so the intonation carries across a paragraph, the silences between
  sentences are trimmed to a natural length, and passages join on the audio
  clock with no seam.
- **Chooses a voice with you.** Open a book for the first time and each voice
  introduces itself before you pick one. Dozens of natural cloud voices, plus
  whatever your device has installed.
- **Reads the way you like.** Four themes (dark, warm, light, sepia), three
  accents (slate, violet, moss), two highlight styles, type size, line height,
  serif or sans, speed from 0.5× to 2.5×, and a sleep timer.
- **Follows you across devices.** Your place is saved to the sentence, so
  picking up on another device lands where you stopped. Bookmarks and
  settings travel too. A book whose text isn't on the device you're holding
  shows greyed until you add the same file again.
- **Counts what's been read.** The home page shows how many hours have been
  read aloud, by how many readers, and how many are listening right now.
  Those badges at the top of this page are live.

## How it works

Everything runs in the browser and a Next.js app on Vercel; Supabase holds
accounts and the small amount of state that syncs.

**Speech sits behind one interface.** `SpeechEngine`
(`src/lib/speech/engine.ts`) is the seam: on-device speech synthesis and the
cloud voices are two implementations, and nothing above the seam knows which
is playing. A new engine that returns audio plus word timings drops in without
touching the reader.

**One sentence at a time.** Chapters are split with `Intl.Segmenter` and
spoken sentence by sentence, chained on end. Short utterances keep pause,
resume and seek reliable on every browser, and give the timing model a fresh
calibration point each sentence.

**The highlight has two clocks.** `src/lib/speech/synchronizer.ts` uses real
word-boundary events when the engine sends them. If none arrive within 400ms
it walks the words on a timer using per-word estimates from word length,
punctuation and speed, and switches back the moment a boundary event shows
up. Each sentence's real duration feeds a per-voice calibration kept across
sessions, so timing improves over the first few sentences and stays good.

**Highlights are drawn, not styled.** `HighlightLayer` paints measured
rectangles behind the text. The pill is one element that moves and resizes,
so the eye tracks an object rather than a strobe.

**Cloud voices sound continuous** (`src/lib/speech/edge/`). Sentences are
sent for synthesis together — a short opening passage so play feels
immediate, then larger ones, always ending at paragraph breaks — so the
model shapes intonation across a paragraph rather than dropping to a full
stop after every sentence. The audio that comes back carries about a second
of silence after every sentence, so `tighten.ts` finds each silent run and
shortens it: 380ms between sentences, 620ms between paragraphs, phrasing
pauses left alone, word timings shifted to match. The next passage is decoded
while the current one plays and scheduled on the audio clock to begin the
instant the current one's closing pause ends.

**Local first.** Parsed books live in IndexedDB; reading place, voice, speed
and appearance in localStorage. The app works in full with no network and no
account. On top of that, `src/lib/sync/` keeps book metadata, places,
bookmarks, settings and listening time on the account: newest copy wins,
positions are written on pause and as the page closes, and the home counter
reads one pre-aggregated row rather than scanning sessions.

**Design tokens are one ladder.** Every theme in `src/app/globals.css` is the
same lightness and chroma ladder with a different hue, and the accent is a
hue rotation on top. That's what keeps 4 themes × 3 accents × 2 highlights
feeling like one product.

## Contributing

Aloud is MIT-licensed and open to contributions of every size. Start with
[CONTRIBUTING.md](CONTRIBUTING.md) for how to run it, how the code is laid
out, and what makes a good pull request. Ideas and questions go in
[Discussions](https://github.com/RonakToprani/Aloud/discussions); bugs in
[Issues](https://github.com/RonakToprani/Aloud/issues).

```bash
npm install
npm run dev
npm test
```

## Licence

[MIT](LICENSE).
