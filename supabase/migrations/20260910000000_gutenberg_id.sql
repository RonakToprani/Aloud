-- A book from the public library remembers which one it is, so a second
-- device signed in to the same account can fetch it again from Project
-- Gutenberg rather than ask the reader for a file they never had.
--
-- An integer of metadata, in a table that holds nothing but metadata. The
-- text still never leaves the device that parsed it.

alter table public.books
  add column if not exists gutenberg_id integer;
