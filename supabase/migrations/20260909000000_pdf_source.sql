-- PDFs read like any other book, so `source` gains a fourth value. The
-- column exists to word one sentence: which file to ask for again when a
-- book is on the account but not on this device.
--
-- Until this is applied, a device that adds a PDF pushes a row the check
-- constraint rejects, and the book, its position and its bookmarks stop
-- syncing silently. It goes up before the deploy that can create one.

alter table public.books drop constraint if exists books_source_check;

alter table public.books
  add constraint books_source_check check (source in ('epub', 'pdf', 'txt', 'paste'));
