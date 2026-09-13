import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { reclaimableMatch } from "@/lib/library/import";

const ghost = (title: string, author: string | null = null) => ({
  id: `id-${title}`,
  title,
  author,
  addedAt: 1_700_000_000_000,
});

test("a re-added file lands on the book the account already remembers", () => {
  const shelf = [ghost("The Picture of Dorian Gray", "Oscar Wilde"), ghost("Moby Dick", "Herman Melville")];
  const hit = reclaimableMatch({ title: "The Picture of Dorian Gray", author: "Oscar Wilde" }, shelf);
  assert.equal(hit?.id, "id-The Picture of Dorian Gray");
});

test("case, accents, punctuation and a leading article do not stop a match", () => {
  const shelf = [ghost("The Brothers Karamazov", "Fyodor Dostoyevsky")];
  for (const title of [
    "the brothers karamazov",
    "Brothers Karamazov",
    "The Brothers Karamázov",
    "The Brothers Karamazov!",
  ]) {
    assert.ok(reclaimableMatch({ title, author: "Fyodor Dostoyevsky" }, shelf), title);
  }
});

test("an author filed surname first is the same author", () => {
  // Catalogues file "Austen, Jane"; the EPUB inside says "Jane Austen".
  const shelf = [ghost("Emma", "Austen, Jane")];
  assert.ok(reclaimableMatch({ title: "Emma", author: "Jane Austen" }, shelf));
});

test("a missing author on either side is not a mismatch", () => {
  const shelf = [ghost("Notes", null)];
  assert.ok(reclaimableMatch({ title: "Notes", author: "Someone" }, shelf));
  assert.ok(reclaimableMatch({ title: "Notes" }, [ghost("Notes", "Someone")]));
});

test("a different book by the same author is not a match", () => {
  const shelf = [ghost("Emma", "Jane Austen")];
  assert.equal(reclaimableMatch({ title: "Persuasion", author: "Jane Austen" }, shelf), undefined);
});

test("the same title by a different author is not a match", () => {
  const shelf = [ghost("Poems", "Emily Dickinson")];
  assert.equal(reclaimableMatch({ title: "Poems", author: "Walt Whitman" }, shelf), undefined);
});

test("nothing to reclaim, or nothing to go on, matches nothing", () => {
  assert.equal(reclaimableMatch({ title: "Emma", author: "Jane Austen" }, []), undefined);
  assert.equal(reclaimableMatch({ title: "Emma" }, undefined), undefined);
  assert.equal(reclaimableMatch({ title: "   " }, [ghost("")]), undefined);
});
