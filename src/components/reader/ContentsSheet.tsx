"use client";

import { BookmarkIcon, TrashIcon } from "@/components/ui/Icons";
import { Segmented } from "@/components/ui/Controls";
import { Sheet } from "@/components/ui/Sheet";
import type { Bookmark } from "@/lib/types";
import { useState } from "react";
import styles from "./Sheets.module.css";

interface Props {
  open: boolean;
  onClose: () => void;
  chapterTitles: string[];
  currentChapter: number;
  onChapter: (index: number) => void;
  bookmarks: Bookmark[];
  onBookmark: (mark: Bookmark) => void;
  onDeleteBookmark: (id: string) => void;
}

type Tab = "chapters" | "bookmarks";

export function ContentsSheet({
  open,
  onClose,
  chapterTitles,
  currentChapter,
  onChapter,
  bookmarks,
  onBookmark,
  onDeleteBookmark,
}: Props) {
  const [tab, setTab] = useState<Tab>("chapters");

  return (
    <Sheet open={open} title="Contents" onClose={onClose} tall>
      <Segmented<Tab>
        label="Contents view"
        value={tab}
        onChange={setTab}
        options={[
          { value: "chapters", label: "Chapters" },
          {
            value: "bookmarks",
            label: bookmarks.length ? `Bookmarks · ${bookmarks.length}` : "Bookmarks",
          },
        ]}
      />

      {tab === "chapters" ? (
        <div className={styles.chapterList}>
          {chapterTitles.map((title, index) => (
            <button
              key={index}
              type="button"
              className={styles.chapterRow}
              data-active={index === currentChapter ? "true" : undefined}
              aria-current={index === currentChapter ? "true" : undefined}
              onClick={() => onChapter(index)}
            >
              <span className={styles.chapterNumber}>{index + 1}</span>
              <span className={styles.chapterTitle}>{title}</span>
            </button>
          ))}
        </div>
      ) : bookmarks.length ? (
        <div className={styles.chapterList}>
          {bookmarks.map((mark) => (
            <div key={mark.id} className={styles.bookmarkRow}>
              <button
                type="button"
                className={styles.bookmarkJump}
                onClick={() => onBookmark(mark)}
              >
                <span className={styles.bookmarkChapter}>{mark.chapterTitle}</span>
                <span className={styles.bookmarkPreview}>{mark.preview}</span>
              </button>
              <button
                type="button"
                className={styles.bookmarkDelete}
                onClick={() => onDeleteBookmark(mark.id)}
                aria-label={`Remove bookmark: ${mark.preview}`}
              >
                <TrashIcon size={16} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.empty}>
          <BookmarkIcon size={22} />
          <p className={styles.emptyTitle}>No bookmarks yet</p>
          <p className={styles.hint}>
            Press and hold any sentence while reading to keep your place in it.
          </p>
        </div>
      )}
    </Sheet>
  );
}
