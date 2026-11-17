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
 *
 * It sells one offer to one reader, the accessibility office: a free course
 * first, then a free term, then half their current price. Everything else on
 * the page exists to make that offer easy to say yes to.
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
          Claim your free course
        </a>
      </header>

      <main>
        <section className={styles.hero}>
          <p className={styles.eyebrow}>For disability and accessibility services</p>
          <h1 className={styles.title}>Send us one course. Get it back read aloud by tomorrow.</h1>
          <p className={styles.lede}>
            Send us the readings for any course, scans included. Within 24 hours you get every one back as clean
            text your students can listen to, with each word lit as it is read, plus an MP3 of each. Free, with
            nothing to sign.
          </p>
          <div className={styles.heroActions}>
            <a className={styles.primary} href="#interest">
              Claim your free course
            </a>
            <span className={styles.note}>Five schools for the winter term.</span>
          </div>
          <Demo />
        </section>

        <section className={styles.section} aria-labelledby="offer">
          <h2 id="offer" className={styles.heading}>
            The whole offer
          </h2>
          <div className={styles.column}>
            <ul className={styles.checks}>
              <li>
                <strong>One course, done for you, free.</strong> Every reading converted and read aloud within 24
                hours. Done by hand, that is hours of staff time and about $4 to $5 a page.
              </li>
              <li>
                <strong>A free term for your students.</strong> Aloud runs beside whatever you use now. Nothing to
                install, and no student is ever without a tool.
              </li>
              <li>
                <strong>We move your library over.</strong> Every reading your office has already converted, sorted
                into course folders by us, not by your staff.
              </li>
              <li>
                <strong>Then half what you pay today.</strong> When your current licence renews, Aloud costs half of
                it. The first five schools keep that price for three years.
              </li>
            </ul>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="guarantee">
          <h2 id="guarantee" className={styles.heading}>
            The guarantee
          </h2>
          <p className={styles.lede}>
            Run Aloud for a term. If your students do not use it more than what you have today, walk away and owe
            us nothing. Not for the course, not for the term, not for the move.
          </p>
        </section>

        <section className={styles.section} aria-labelledby="how">
          <h2 id="how" className={styles.heading}>
            How it works
          </h2>
          <ol className={styles.steps}>
            <li>
              <span className={styles.stepNumber}>1</span>
              <div>
                <strong>Tell us which course.</strong> We reply within one business day with where to send the
                readings.
              </div>
            </li>
            <li>
              <span className={styles.stepNumber}>2</span>
              <div>
                <strong>Get it back in 24 hours.</strong> Share it with your students and hear what they think.
              </div>
            </li>
            <li>
              <span className={styles.stepNumber}>3</span>
              <div>
                <strong>Run a free term, then switch at renewal.</strong> We move your library. You pay half.
              </div>
            </li>
          </ol>
        </section>

        <section className={styles.section} aria-labelledby="students">
          <h2 id="students" className={styles.heading}>
            What your students get
          </h2>
          <div className={styles.grid}>
            <Feature title="Natural voices, word by word">
              Every word is lit as it is spoken, so eyes and ears stay together. Speed from half to two and a half
              times.
            </Feature>
            <Feature title="Every kind of reading">
              Scans, PDFs, ebooks and web pages. Two-column papers are read in order and contents pages are
              skipped.
            </Feature>
            <Feature title="Wherever they read">
              Laptop or phone, online or off. A Listen button beside readings in Brightspace and Canvas, and the
              Chrome extension on any web page.
            </Feature>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="questions">
          <h2 id="questions" className={styles.heading}>
            Questions offices ask
          </h2>
          <ul className={styles.list}>
            <li>
              <strong>What is the catch?</strong> There isn&apos;t one. We are choosing five schools to build with,
              and doing the work is the fastest way to show you.
            </li>
            <li>
              <strong>We are partway through a contract.</strong> Good. Run the free term now and switch the day
              your licence renews, so you never pay for two tools.
            </li>
            <li>
              <strong>Will it pass our IT and privacy review?</strong> Files stay on the student&apos;s device and
              the voice runs there too. You get a VPAT, a completed HECVAT and a signed data agreement before your
              review starts, plus campus sign-in. The code is open source.
            </li>
            <li>
              <strong>What do students have to install?</strong> Nothing. It runs in any browser, and your IT team
              can push the Chrome extension to managed browsers.
            </li>
          </ul>
        </section>

        <section className={`${styles.section} ${styles.formSection}`} id="interest" aria-labelledby="interest-title">
          <h2 id="interest-title" className={styles.heading}>
            Claim your free course
          </h2>
          <p className={styles.formLede}>Five schools for the winter term. It takes a minute.</p>
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
