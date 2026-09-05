# Contributing to Aloud

Thanks for being here. Aloud is open source under the MIT licence, and
everything from a typo fix to a new speech engine is welcome.

## Getting a copy running

```bash
git clone https://github.com/RonakToprani/Aloud.git
cd Aloud
npm install
npm run dev          # http://localhost:3000
```

That gives you the whole reader, local-only: import books, play them, tweak
appearance. Cloud voices work out of the box through the app's own API route.

Accounts and sync need a Supabase project. Copy `.env.example` to `.env.local`,
create a free project, run `supabase/migrations/*.sql` in its SQL editor, and
turn on Email and Anonymous sign-ins under Authentication › Providers. Without
the two variables the app simply runs without accounts, which is fine for
most changes.

## Checks

```bash
npm test             # unit tests, run on every PR
npm run typecheck
npm run build
```

`scripts/` holds tools for the things tests can't cover: screenshots of every
screen, and timelines of how cloud audio is scheduled through the real player.

## How the code is laid out

- `src/lib/speech/` — the `SpeechEngine` interface and its implementations
  (on-device speech, cloud voices). Anything above this seam is engine-agnostic.
- `src/lib/player/` — playback: one sentence at a time, chained on end.
- `src/lib/text/` and `src/lib/epub/` — segmentation and EPUB parsing.
- `src/lib/storage/` — IndexedDB for books, localStorage for settings and places.
- `src/lib/sync/` — the account layer: what syncs, presence, listening time.
- `src/components/` — the UI, organised by screen.
- `supabase/` — schema, policies and project config.

The README's "How it works" section explains the design decisions that are
easy to undo by accident, particularly around highlight timing and cloud
audio. Read it before changing either.

## Pull requests

- Open an issue first for anything larger than a fix, so we can agree on the
  shape before you build it.
- Keep PRs focused. One change, explained in the description: what was wrong
  or missing, what you did, and how you checked it.
- Match the surrounding style. Comments explain *why*, not what.
- Run the checks above. CI runs them too.
- Design changes should follow the existing tokens in `src/app/globals.css`;
  every theme is one lightness ladder with a different hue, and that
  relationship is what keeps 24 theme/accent/highlight combinations coherent.

## Reporting bugs

Use the bug template. The most useful details are the device and browser, the
voice in use, and whether the book was an EPUB, a text file, or pasted text.
Audio problems benefit hugely from a rough timestamp of when it happened.

## Code of conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
