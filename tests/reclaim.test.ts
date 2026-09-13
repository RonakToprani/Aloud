import "./setup";
import assert from "node:assert/strict";
import test from "node:test";
import { reclaimableMatch } from "@/lib/library/import";

const ghost = (title: string, author: string | null = null, wordCount = 80_000) => ({
  id: `id:${title}:${author ?? "-"}`,
  title,
  author,
  wordCount,
  addedAt: 1_700_000_000_000,
});

test("a re-added file lands on the book the account already remembers", () => {
  const shelf = [ghost("The Picture of Dorian Gray", "Oscar Wilde"), ghost("Moby Dick", "Herman Melville")];
  const hit = reclaimableMatch({ title: "The Picture of Dorian Gray", author: "Oscar Wilde", wordCount: 80_000 }, shelf);
  assert.equal(hit?.id, "id:The Picture of Dorian Gray:Oscar Wilde");
});

test("case, accents, punctuation and a leading article do not stop a match", () => {
  const shelf = [ghost("The Brothers Karamazov", "Fyodor Dostoyevsky")];
  for (const title of [
    "the brothers karamazov",
    "Brothers Karamazov",
    "The Brothers Karamázov",
    "The Brothers Karamazov!",
  ]) {
    assert.ok(reclaimableMatch({ title, author: "Fyodor Dostoyevsky", wordCount: 80_000 }, shelf), title);
  }
});

test("an author filed surname first is the same author", () => {
  const shelf = [ghost("Emma", "Austen, Jane")];
  assert.ok(reclaimableMatch({ title: "Emma", author: "Jane Austen", wordCount: 80_000 }, shelf));
});

test("another edition of the same book still matches", () => {
  // Front matter and notes differ between builds; the book does not.
  const shelf = [ghost("Emma", "Jane Austen", 80_000)];
  assert.ok(reclaimableMatch({ title: "Emma", author: "Jane Austen", wordCount: 88_000 }, shelf));
});

/* ---------------- the ways two different books must stay apart ------------ */

test("the same title by a different author is not a match", () => {
  const shelf = [ghost("Poems", "Emily Dickinson")];
  assert.equal(reclaimableMatch({ title: "Poems", author: "Walt Whitman", wordCount: 80_000 }, shelf), undefined);
});

test("a different book by the same author is not a match", () => {
  const shelf = [ghost("Emma", "Jane Austen")];
  assert.equal(reclaimableMatch({ title: "Persuasion", author: "Jane Austen", wordCount: 80_000 }, shelf), undefined);
});

test("same title and author, but nothing like the same length, is not a match", () => {
  // Two different collections a writer called "Selected Poems".
  const shelf = [ghost("Selected Poems", "W B Yeats", 12_000)];
  assert.equal(
    reclaimableMatch({ title: "Selected Poems", author: "W B Yeats", wordCount: 40_000 }, shelf),
    undefined,
  );
});

test("a nameless file does not claim a book that has an author", () => {
  // "Notes" by nobody is no evidence of "Notes" by someone.
  const shelf = [ghost("Notes", "Someone")];
  assert.equal(reclaimableMatch({ title: "Notes", wordCount: 80_000 }, shelf), undefined);
  assert.equal(
    reclaimableMatch({ title: "Notes", author: "Someone", wordCount: 80_000 }, [ghost("Notes", null)]),
    undefined,
  );
});

test("two nameless files of the same name and length still match", () => {
  const shelf = [ghost("Notes", null, 900)];
  assert.ok(reclaimableMatch({ title: "Notes", wordCount: 900 }, shelf));
});

test("two candidates it could equally be is a coin toss, so neither wins", () => {
  const shelf = [ghost("Poems", "Anon", 5_000), { ...ghost("Poems", "Anon", 5_100), id: "second" }];
  assert.equal(reclaimableMatch({ title: "Poems", author: "Anon", wordCount: 5_000 }, shelf), undefined);
});

test("without a length on either side there is no evidence, so no match", () => {
  const shelf = [{ id: "x", title: "Emma", author: "Jane Austen", addedAt: 1 }];
  assert.equal(reclaimableMatch({ title: "Emma", author: "Jane Austen", wordCount: 80_000 }, shelf), undefined);
  assert.equal(reclaimableMatch({ title: "Emma", author: "Jane Austen" }, [ghost("Emma", "Jane Austen")]), undefined);
});

test("nothing to reclaim, or nothing to go on, matches nothing", () => {
  assert.equal(reclaimableMatch({ title: "Emma", author: "Jane Austen", wordCount: 1 }, []), undefined);
  assert.equal(reclaimableMatch({ title: "Emma", wordCount: 1 }, undefined), undefined);
  assert.equal(reclaimableMatch({ title: "   ", wordCount: 1 }, [ghost("")]), undefined);
});
