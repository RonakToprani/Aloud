# Aloud for Campus

Written 17 September 2026. The plan for turning Aloud from a reader into an
assistive technology product that a college or university accessibility
office will pilot, and for putting a company behind it. The customer is the
accommodations coordinator: the person with the Kurzweil budget line and a
legal duty to serve accommodated students. The student is who the product
serves. Everything below is judged by what those two people see.

The addresses of every Ontario office, and the software each one says it
licenses, are in `emails/outreach-campus-offices.csv`, which git ignores.
The drafted January batch is `emails/outreach-campus.json`, unsent.

## The ten-minute test

What a coordinator or assistive technologist does with a new tool before
deciding whether to mention it to anyone. Aloud has to pass all of it
before the first campus email goes out.

1. Opens it on a phone and a laptop. Reads a page. Passes today.
2. Uploads a scanned course reading, a PDF with no text layer. Fails today.
3. Uploads a two-column textbook chapter with figures. Passes today.
4. Looks for a dyslexia-friendly typeface, a reading ruler, spacing. Fails today.
5. Highlights a passage, adds a note, looks for a study guide export. Fails today.
6. Holds a word for a definition. Fails today.
7. Tabs through the controls with a keyboard and a screen reader. Unaudited.
8. Asks how students get it and whether they can see who used it. Fails today.
9. Asks whether it can read an exam in the testing centre. Fails today.
10. Looks for a privacy statement and an accessibility conformance
    statement. Neither exists.

## What makes it feel like assistive technology

In the order a coordinator hits them, with the scope of each.

**Reading supports.** A dyslexia-friendly typeface (Atkinson Hyperlegible
and OpenDyslexic are both free to bundle), a reading ruler that follows the
spoken line, a screen mask that dims everything but the current paragraph,
letter and word spacing, and a high-contrast theme on the existing ladder.
These live in the appearance sheet beside size and leading. Days of work, and
the single biggest change to how the product reads to this audience.

**OCR.** Tesseract runs in the browser as WebAssembly, so a scanned page is
recognised on the device and the text never leaves it, which keeps the
privacy promise intact. A PDF page with no text layer goes through it, and
so does a photo of a page. Its output feeds `pdf/layout.ts` as lines, the
same as pdf.js text. One to two weeks.

**Study tools.** Coloured highlights on sentence and word ranges, built on
the bookmark machinery and synced the same way. A note on a highlight. A
vocabulary list. One export, Markdown or print, that gathers a book's
highlights and notes in order: this is the study guide Kurzweil students are
taught to make. Two to three weeks.

**Word tools.** Hold a word for a definition, from a bundled dictionary so it
works offline. Translation later, for the language learners. A week.

**Exam mode.** A locked reader for the testing centre: one document, no
library, no notes, no web, a proctor code to leave. Testing centres are where
Kurzweil is most used and least liked. Two weeks.

**Dictation.** Browser speech recognition into a note. Days.

**The reader is itself accessible.** Every control reachable by keyboard,
labelled for a screen reader, sensible focus order, reduced motion honoured.
An accessibility office will check with VoiceOver and a keyboard, and a
reading tool that fails its own audit is disqualified. Audit with axe, fix,
then write the conformance statement from the result. A week.

**Any text in.** Word files through mammoth.js, a URL through Readability,
and the Web Share Target so a phone shares a file or link straight to Aloud.
Google Drive and OneDrive pickers. Two weeks. A browser extension later.

## What makes it feel like a company

**Pages.** `/campus` for accessibility offices: what it does for accommodated
students, the privacy promise, the accessibility statement, how a pilot
works, who to write to. `/privacy`, `/terms`, `/accessibility` and
`/security`, each one page in plain language. A changelog. None exist today.

**A support inbox that receives mail.** The sending address has no inbound
mail exchanger, so a reply typed by hand bounces. A coordinator will type
the address. Fix the DNS or move to an address that receives.

**Organisation accounts.** Students join by email domain or a code.
Microsoft sign-in beside Google, since most Ontario campuses run Microsoft
365. A usage page for the coordinator: students, hours, books, never
content. This is what a renewal is decided on.

**Collateral.** A one-page PDF for coordinators. A ninety-second video of a
scanned reading going in and coming out read aloud on a phone. A demo scan.
Screenshots of the reading supports.

**A legal entity, before the first licence.** Pilots need none. A purchase
order needs a legal name, a tax number and sometimes proof of insurance. An
Ontario or federal incorporation costs a few hundred dollars and a day.

## Sequence

| Weeks | Ship | What can be shown after |
|---|---|---|
| 1 to 2 | Reading supports, the five pages, the support inbox | It looks like assistive technology and there is a company behind it |
| 3 to 4 | OCR | A scanned reading goes in and is read aloud |
| 5 | Accessibility audit and conformance statement | The tool passes its own test |
| 6 to 8 | Highlights, notes, study guide export, dictionary | The study half of Kurzweil |
| 9 to 10 | Organisation accounts, usage page, Microsoft sign-in | A pilot can be measured |
| 11 to 12 | Exam mode, collateral | The testing centre has a reason to switch |

**The three design partners are approached after week 5,** when the
ten-minute test passes, not before. Toronto first, in person: U of T St.
George, Seneca, and one campus-wide Kurzweil licence holder by video,
Waterloo or Laurier. The ask is thirty minutes with the assistive
technologist and two or three students, with no mention of money.

**The other forty-two offices hear about it in January,** at the start of
the winter term and before spring budgets, with a partner's name, a
coordinator's quote and real usage numbers in the email.

**The literacy and language channel keeps running on the current product**
throughout, since those organisations replied well to what exists.
