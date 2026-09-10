import assert from "node:assert/strict";
import test from "node:test";
import { displayName, splitTitle } from "@/lib/gutenberg/catalogue";

test("catalogue names are said the way a person says them", () => {
  assert.equal(displayName("Austen, Jane"), "Jane Austen");
  assert.equal(displayName("Homer"), "Homer");
  assert.equal(displayName("Tolstoy, Leo, graf"), "Leo Tolstoy");
  assert.equal(displayName("Twain, Mark (Samuel Clemens)"), "Mark Twain");
  assert.equal(displayName("Shelley, Mary Wollstonecraft"), "Mary Wollstonecraft Shelley");
});

test("an epithet after the comma is not a given name", () => {
  assert.equal(displayName("Marcus Aurelius, Emperor of Rome"), "Marcus Aurelius");
  assert.equal(displayName("Sunzi, active 6th century B.C."), "Sunzi");
  assert.equal(displayName("Augustine, of Hippo"), "Augustine");
  assert.equal(displayName("Henry VIII, King of England"), "Henry VIII");
  assert.equal(displayName(""), "");
});

test("long catalogue titles are cut at the first mark", () => {
  assert.deepEqual(splitTitle("Moby Dick; Or, The Whale"), { title: "Moby Dick", subtitle: "The Whale" });
  assert.deepEqual(splitTitle("Frankenstein; Or, The Modern Prometheus"), {
    title: "Frankenstein",
    subtitle: "The Modern Prometheus",
  });
  assert.deepEqual(splitTitle("Le Morte d'Arthur: Volume 1"), { title: "Le Morte d'Arthur", subtitle: "Volume 1" });
  assert.deepEqual(splitTitle("Pride and Prejudice"), { title: "Pride and Prejudice", subtitle: null });
});

test("MARC subfield codes never reach a reader", () => {
  assert.deepEqual(splitTitle("His Last Bow : $b Some later reminiscences of Sherlock Holmes"), {
    title: "His Last Bow",
    subtitle: "Some later reminiscences of Sherlock Holmes",
  });
  assert.deepEqual(splitTitle("The Sign of the Four $b or, The problem of the Sholtos"), {
    title: "The Sign of the Four",
    subtitle: "The problem of the Sholtos",
  });
});
