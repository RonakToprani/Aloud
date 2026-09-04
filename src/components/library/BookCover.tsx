"use client";

import { useEffect, useState } from "react";
import type { BookMeta } from "@/lib/types";
import styles from "./BookCover.module.css";

/** Stable hue per title, so a book always looks like the same book. */
function hueOf(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % 360;
}

/**
 * A book's cover is its own object, not part of the interface, so the drawn
 * covers keep fixed colours rather than following the reader's theme — the
 * same way a paperback does not change colour when the lamp does.
 */
function DrawnCover({ meta }: { meta: BookMeta }) {
  const hue = hueOf(meta.title || meta.id);
  return (
    <div
      className={styles.drawn}
      style={{
        ["--h" as string]: String(hue),
      }}
    >
      <span className={styles.drawnRule} aria-hidden="true" />
      <span className={styles.drawnTitle}>{meta.title}</span>
      {meta.author && <span className={styles.drawnAuthor}>{meta.author}</span>}
    </div>
  );
}

interface Props {
  meta: BookMeta;
  /** Larger covers get the fuller drawn treatment. */
  size?: "sm" | "lg";
  className?: string;
}

export function BookCover({ meta, size = "sm", className }: Props) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!meta.cover) return;
    const objectUrl = URL.createObjectURL(meta.cover);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [meta.cover]);

  return (
    <div className={`${styles.cover} ${className ?? ""}`} data-size={size}>
      {url && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className={styles.image}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <DrawnCover meta={meta} />
      )}
    </div>
  );
}
