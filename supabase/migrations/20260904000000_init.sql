-- Aloud — Supabase schema.
--
-- Stores everything about a reader except the books themselves: settings,
-- library metadata, reading positions, bookmarks and listening time. Book
-- text never leaves the device ("Books stay yours. We store your progress,
-- not your files.").
--
-- Run this in the SQL editor of a fresh project, or with `supabase db push`.
-- Then, in Authentication › Providers, enable Email (magic link) and
-- Anonymous sign-ins; Apple and Google are optional.

-- ---------------------------------------------------------------- helpers

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- profiles

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  -- The reader's appearance and playback settings, as one document, so they
  -- follow the reader across devices. The client owns the shape.
  settings jsonb not null default '{}'::jsonb,
  settings_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- books

-- Metadata only: enough to list the library, show progress and map a saved
-- position back onto the text once the reader adds the file again.
create table if not exists public.books (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  author text,
  source text not null check (source in ('epub', 'txt', 'paste')),
  added_at timestamptz not null default now(),
  sentence_count integer not null default 0,
  word_count integer not null default 0,
  chapter_titles jsonb not null default '[]'::jsonb,
  chapter_sentence_counts jsonb not null default '[]'::jsonb,
  chapter_word_counts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists books_user_idx on public.books (user_id, added_at desc);

create trigger books_updated_at before update on public.books
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- positions

create table if not exists public.reading_positions (
  book_id text primary key references public.books (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  chapter_index integer not null default 0,
  sentence_index integer not null default 0,
  word_index integer not null default 0,
  -- Set by the client from its own clock, so two devices can agree which
  -- copy is newer even when their writes arrive out of order.
  updated_at timestamptz not null default now()
);

create index if not exists reading_positions_user_idx on public.reading_positions (user_id);

-- ---------------------------------------------------------------- bookmarks

create table if not exists public.bookmarks (
  id text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id text not null references public.books (id) on delete cascade,
  chapter_index integer not null default 0,
  sentence_index integer not null default 0,
  preview text not null default '',
  chapter_title text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists bookmarks_book_idx on public.bookmarks (user_id, book_id);

-- ---------------------------------------------------------------- sessions

-- One row per stretch of listening. The client upserts the running total
-- for the session every few seconds, so a crash loses seconds, not minutes.
create table if not exists public.reading_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  book_id text references public.books (id) on delete set null,
  seconds integer not null default 0 check (seconds >= 0 and seconds <= 86400),
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists reading_sessions_user_idx on public.reading_sessions (user_id, updated_at desc);
create index if not exists reading_sessions_recent_idx on public.reading_sessions (updated_at desc);

-- ---------------------------------------------------------------- stats

-- A single pre-aggregated row for the home counter. The client reads this;
-- it never sums sessions itself.
create table if not exists public.reading_stats (
  id smallint primary key default 1 check (id = 1),
  total_seconds bigint not null default 0,
  readers bigint not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.reading_stats (id) values (1) on conflict (id) do nothing;

-- Sessions fold their delta into the total as they are written.
create or replace function public.apply_session_delta()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  delta integer;
begin
  if tg_op = 'INSERT' then
    delta := new.seconds;
  else
    delta := new.seconds - old.seconds;
  end if;
  if delta <> 0 then
    update public.reading_stats
      set total_seconds = greatest(0, total_seconds + delta), updated_at = now()
      where id = 1;
  end if;
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists reading_sessions_delta on public.reading_sessions;
create trigger reading_sessions_delta
  before insert or update on public.reading_sessions
  for each row execute function public.apply_session_delta();

-- Every account gets a profile and counts as a reader, anonymous or not.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  update public.reading_stats set readers = readers + 1, updated_at = now() where id = 1;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.handle_deleted_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.reading_stats set readers = greatest(0, readers - 1), updated_at = now() where id = 1;
  return old;
end $$;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public.handle_deleted_user();

-- What the home page shows. Readers active in the last week come from an
-- index scan over recent sessions, which stays cheap at any realistic size.
create or replace function public.public_stats()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'total_seconds', s.total_seconds,
    'readers', s.readers,
    'active_readers', (
      select count(distinct user_id) from public.reading_sessions
      where updated_at > now() - interval '7 days'
    ),
    'updated_at', s.updated_at
  )
  from public.reading_stats s where s.id = 1;
$$;

grant execute on function public.public_stats() to anon, authenticated;

-- ---------------------------------------------------------------- RLS

alter table public.profiles enable row level security;
alter table public.books enable row level security;
alter table public.reading_positions enable row level security;
alter table public.bookmarks enable row level security;
alter table public.reading_sessions enable row level security;
alter table public.reading_stats enable row level security;

create policy "own profile" on public.profiles
  for all to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create policy "own books" on public.books
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own positions" on public.reading_positions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own bookmarks" on public.bookmarks
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "own sessions" on public.reading_sessions
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Everyone may read the counter; nothing writes it except the triggers.
create policy "stats are public" on public.reading_stats
  for select to anon, authenticated using (true);
