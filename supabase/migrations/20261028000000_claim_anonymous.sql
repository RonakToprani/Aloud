-- Signing in from an anonymous session starts a different account: the email
-- code, the magic link and OAuth all sign in as a new user rather than
-- converting the anonymous one. Everything the reader did before signing in
-- (their books, places, bookmarks and listening) stayed on the anonymous
-- account, and because book ids are global the real account could not even
-- write those books again: every push was refused by RLS, silently, and the
-- reader's second device never saw them.
--
-- So an anonymous session asks for a claim before it signs in, and the
-- account it signs into redeems it, which moves the rows across. The claim is
-- a random token only that browser holds; it is only issued to an anonymous
-- user and only redeemed against one that is still anonymous, so it can never
-- move a real account's data.

create table if not exists public.account_claims (
  token uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Reached only through the two functions below.
alter table public.account_claims enable row level security;

create or replace function public.issue_account_claim()
returns uuid language plpgsql security definer set search_path = public as $$
declare
  claim uuid;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) is not true then
    return null;
  end if;
  delete from public.account_claims where user_id = auth.uid();
  insert into public.account_claims (user_id) values (auth.uid()) returning token into claim;
  return claim;
end $$;

create or replace function public.redeem_account_claim(claim uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  from_user uuid;
  to_user uuid := auth.uid();
  moved integer := 0;
  both_listened boolean;
begin
  if to_user is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return 0;
  end if;
  delete from public.account_claims
    where token = claim and created_at > now() - interval '1 day'
    returning user_id into from_user;
  if from_user is null or from_user = to_user then
    return 0;
  end if;
  if not exists (select 1 from auth.users where id = from_user and is_anonymous) then
    return 0;
  end if;

  -- The public count of readers counted each account that listened; two
  -- that become one reader should count once.
  both_listened :=
    exists (select 1 from public.reading_sessions where user_id = from_user and seconds > 0) and
    exists (select 1 from public.reading_sessions where user_id = to_user and seconds > 0);

  update public.books set user_id = to_user where user_id = from_user;
  get diagnostics moved = row_count;
  update public.reading_positions set user_id = to_user where user_id = from_user;
  update public.bookmarks set user_id = to_user where user_id = from_user;
  -- Seconds are unchanged by the move, so the session trigger adds nothing.
  update public.reading_sessions set user_id = to_user where user_id = from_user;

  if both_listened then
    update public.reading_stats set readers = greatest(0, readers - 1), updated_at = now() where id = 1;
  end if;
  return moved;
end $$;

revoke all on function public.issue_account_claim() from public, anon;
revoke all on function public.redeem_account_claim(uuid) from public, anon;
grant execute on function public.issue_account_claim() to authenticated;
grant execute on function public.redeem_account_claim(uuid) to authenticated;
