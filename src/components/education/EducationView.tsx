"use client";

import { Fragment, useEffect, useState } from "react";
import { Logo } from "@/components/ui/Logo";
import { InterestForm } from "./InterestForm";
import styles from "./Education.module.css";

/** Forwarded to a person; see "Inbound mail" in CLAUDE.md. */
const CONTACT_EMAIL = "hello@aloudreader.org";

const DEMO = "Students follow every word as it is spoken, at the pace that suits them.".split(" ");

/**
 * The education page stands on its own: it never links to the reader or the
 * library, because the people reading it are buying for a campus, not
 * looking for a book. It is always drawn in the light theme, whatever the
 * visitor's saved reader theme, since it is a page to be read once and
 * forwarded, not a place to read at night.
 */
export function EducationView() {
  return (
    <div className={styles.page} data-theme="light" data-accent="slate">
      <header className={styles.header}>
        <span className={styles.brand}>
          <Logo size={24} />
          <span className={styles.brandTag}>for Education</span>
        </span>
        <a className={styles.headerCta} href="#interest">
          Join the early list
        </a>
      </header>

      <main>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>Accessibility software for universities and colleges</p>
          <h1 className={styles.title}>Every course reading, read aloud.</h1>
          <p className={styles.lede}>
            Aloud reads PDFs, ebooks and web pages to students in a natural voice, and lights up each word as it is
            spoken. It is for every student on campus, not only the ones with an accommodation letter. We are
            opening it to schools, starting with a small group of early partners.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primary} href="#interest">
              Register your interest
            </a>
            <span className={styles.note}>Free to join. No commitment.</span>
          </div>
          <Demo />
        </section>

        <section className={styles.section} aria-labelledby="students">
          <h2 id="students" className={styles.heading}>
            What students get
          </h2>
          <div className={styles.grid}>
            <Feature title="Their own readings, aloud">
              Course PDFs, EPUBs, text files, or anything pasted in. Aloud works out a PDF&apos;s paragraphs and
              columns from its layout, so a two-column paper is read in order and a contents page is skipped.
            </Feature>
            <Feature title="The web, too">
              The Aloud Chrome extension reads the page in front of them: an article, a course page, a library
              database. One button, or Alt+A, and the highlight is drawn right over the page.
            </Feature>
            <Feature title="Follow along, word by word">
              The sentence being read is shaded and the word being spoken is lit, so eyes and ears stay together.
              Tap any word to start reading from there.
            </Feature>
            <Feature title="Voices worth listening to">
              Dozens of natural voices across many languages, chosen to match the language of the page, plus any
              voice already on the device.
            </Feature>
            <Feature title="Set up the way they read">
              Speed from half to two and a half times, type size, line spacing, serif or sans, and four colour
              themes, including a dark one for late nights.
            </Feature>
            <Feature title="On every device">
              It runs in the browser on a laptop or a phone. Saved to a phone&apos;s home screen, it keeps reading
              with the screen locked, and their place follows them from one device to the next.
            </Feature>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="coming">
          <h2 id="coming" className={styles.heading}>
            What we build with our partner schools
          </h2>
          <p className={styles.sectionLede}>
            We build what saves your office time and what your students use, not a toolbar of twenty buttons. The
            first list comes with the pilot. The second we build with partner schools, on a timeline we agree
            together.
          </p>
          <div className={styles.columns}>
            <div className={styles.column}>
              <h3 className={styles.columnTitle}>Included in the pilot</h3>
              <ul className={styles.checks}>
                <li>
                  Scanned PDFs and photos of pages read aloud the moment a student opens them, with no wait for
                  conversion
                </li>
                <li>A Listen button beside every reading in Brightspace, so there is no new app for students to adopt</li>
                <li>Course folders your office fills with readings and shares with the students who need them</li>
                <li>A test mode for exam centres that limits the tools to the ones an exam allows</li>
                <li>Any reading saved as an MP3 to listen to on the go</li>
                <li>Voices that keep working offline, so an accommodation never goes silent</li>
                <li>A reading ruler and screen mask for focus</li>
              </ul>
            </div>
            <div className={styles.column}>
              <h3 className={styles.columnTitle}>Built with you</h3>
              <ul className={styles.checks}>
                <li>Definitions, pronunciation and translation for any word</li>
                <li>Highlights and notes, gathered into study notes students can export</li>
                <li>Word, DAISY and e-textbook files, including your office&apos;s alternate formats</li>
                <li>The same Listen button in Canvas and Moodle</li>
                <li>Math read aloud from MathML and LaTeX</li>
              </ul>
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="offices">
          <h2 id="offices" className={styles.heading}>
            For accessibility offices and IT
          </h2>
          <ul className={styles.list}>
            <li>
              <strong>Campus-wide access.</strong> One licence for the whole institution, so a student does not have
              to wait for an accommodation letter to start listening.
            </li>
            <li>
              <strong>Nothing to install for the reader.</strong> Aloud runs in any modern browser. The Chrome
              extension can be pushed to managed Chrome browsers from your admin console.
            </li>
            <li>
              <strong>Campus sign-in and an admin console.</strong> Students sign in with their school account
              through SAML, Google or Microsoft. Your office sees seats and usage, so a renewal is easy to make the
              case for.
            </li>
            <li>
              <strong>Ready for procurement.</strong> A VPAT, a completed HECVAT and a signed data agreement
              covering FERPA in the US, and PIPEDA and provincial privacy law in Canada, ready before your review
              starts. Canadian data hosting is available on request.
            </li>
            <li>
              <strong>We move you over.</strong> We bring your converted readings across into course folders, run
              alongside your current tool for a term at no cost, and time the switch to your renewal. Your students
              never lose an accommodation mid-term.
            </li>
            <li>
              <strong>Narrow permissions.</strong> The extension can see a page only after the student presses its
              button on that page, and not before.
            </li>
            <li>
              <strong>Private by design.</strong> A student&apos;s files stay on their own device. Only the text
              being spoken is sent to be voiced, and it is not kept.
            </li>
            <li>
              <strong>Open source.</strong> Aloud&apos;s code is public under the MIT licence, so your students are
              never stranded by a vendor, and your security team can read every line.
            </li>
            <li>
              <strong>A direct line to the people who build it.</strong> Help with rollout and training, and a say
              in what we build next.
            </li>
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="how">
          <h2 id="how" className={styles.heading}>
            How the early list works
          </h2>
          <ol className={styles.steps}>
            <li>
              <span className={styles.stepNumber}>1</span>
              <div>
                <strong>Tell us about your school.</strong> It takes a minute.
              </div>
            </li>
            <li>
              <span className={styles.stepNumber}>2</span>
              <div>
                <strong>We get in touch.</strong> A short call about your students and what your office needs.
              </div>
            </li>
            <li>
              <span className={styles.stepNumber}>3</span>
              <div>
                <strong>A free pilot term.</strong> Aloud runs beside what you use today. If more of your
                students do not use it, you owe us nothing.
              </div>
            </li>
          </ol>
        </section>

        <section className={`${styles.section} ${styles.formSection}`} id="interest" aria-labelledby="interest-title">
          <h2 id="interest-title" className={styles.heading}>
            Register your interest
          </h2>
          <p className={styles.formLede}>
            For disability services, faculty, libraries, IT, and students who want it at their school.
          </p>
          <InterestForm />
        </section>
      </main>

      <footer className={styles.footer}>
        <span>&copy; {new Date().getFullYear()} Aloud</span>
        <span aria-hidden="true">&middot;</span>
        <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
      </footer>
    </div>
  );
}

function Feature({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.feature}>
      <h3 className={styles.featureTitle}>{title}</h3>
      <p className={styles.featureBody}>{children}</p>
    </div>
  );
}

/** The product's one gesture, shown rather than described: a pill walking a
 *  sentence. Held still on the first word for anyone who asked for less motion. */
function Demo() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setIndex((i) => (i + 1) % (DEMO.length + 3)), 330);
    return () => window.clearInterval(id);
  }, []);
  return (
    <p className={styles.demo} aria-hidden="true">
      <span className={styles.demoSentence}>
        {DEMO.map((word, i) => (
          <Fragment key={i}>
            {i > 0 && " "}
            <span className={i === index ? styles.demoWordLit : styles.demoWord}>{word}</span>
          </Fragment>
        ))}
      </span>
    </p>
  );
}
