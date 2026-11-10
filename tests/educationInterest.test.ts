import assert from "node:assert/strict";
import test from "node:test";
import { notification, parseInterest } from "@/lib/education/interest";

const good = {
  name: "  Sam   Lee ",
  email: "Sam.Lee@Example.EDU",
  institution: "Example University",
  role: "Disability or accessibility services",
  size: "10,000 to 30,000",
  message: "  We use two tools today.\nNeither reads PDFs well.  ",
};

test("a complete answer is tidied and kept", () => {
  const parsed = parseInterest(good);
  assert.ok(parsed.ok);
  assert.equal(parsed.interest.name, "Sam Lee");
  assert.equal(parsed.interest.email, "sam.lee@example.edu");
  assert.equal(parsed.interest.size, "10,000 to 30,000");
  assert.equal(parsed.interest.message, "We use two tools today.\nNeither reads PDFs well.");
});

test("the optional answers may be left out", () => {
  const parsed = parseInterest({ ...good, size: "", message: "" });
  assert.ok(parsed.ok);
  assert.equal(parsed.interest.size, null);
  assert.equal(parsed.interest.message, null);
});

test("each required answer is asked for by name", () => {
  for (const [field, word] of [
    ["name", "name"],
    ["email", "email"],
    ["institution", "institution"],
    ["role", "role"],
  ] as const) {
    const parsed = parseInterest({ ...good, [field]: "" });
    assert.ok(!parsed.ok);
    assert.match(parsed.error, new RegExp(word));
  }
  assert.ok(!parseInterest({ ...good, email: "sam@localhost" }).ok);
  assert.ok(!parseInterest({ ...good, role: "Dean of everything" }).ok);
  assert.ok(!parseInterest({ ...good, size: "a million" }).ok);
  assert.ok(!parseInterest(null).ok);
});

test("an over-long answer is refused", () => {
  assert.ok(!parseInterest({ ...good, message: "x".repeat(2001) }).ok);
});

test("a filled hidden field is marked as a bot", () => {
  const parsed = parseInterest({ ...good, website: "http://spam.example" });
  assert.ok(!parsed.ok);
  assert.equal(parsed.spam, true);
});

test("the notification escapes what was typed", () => {
  const parsed = parseInterest({ ...good, institution: "<script>x</script> College" });
  assert.ok(parsed.ok);
  const note = notification(parsed.interest);
  assert.equal(note.subject, "Education interest: <script>x</script> College");
  assert.ok(!note.html.includes("<script>"));
  assert.ok(note.text.includes("Role: Disability or accessibility services"));
});
