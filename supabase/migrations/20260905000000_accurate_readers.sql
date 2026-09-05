-- A reader is an account that has actually listened, not every anonymous
-- session a visit creates. Counting sign-ups made the figure a measure of
-- page loads (and of the maintainer's own test runs) rather than of people
-- reading. The counter now moves the first time an account records
-- listening time, and the totals are recomputed from the sessions.

-- Stop counting accounts at creation.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end $$;

-- And stop uncounting them at deletion — unless they had listened, in which
-- case their sessions are about to cascade away with them.
create or replace function public.handle_deleted_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.reading_sessions where user_id = old.id and seconds > 0) then
    update public.reading_stats set readers = greatest(0, readers - 1), updated_at = now() where id = 1;
  end if;
  return old;
end $$;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  before delete on auth.users
  for each row execute function public.handle_deleted_user();

-- Count a reader the first time an account records a second of listening.
create or replace function public.apply_session_delta()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  delta integer;
  had_listened boolean;
begin
  if tg_op = 'INSERT' then
    delta := new.seconds;
    had_listened := exists (
      select 1 from public.reading_sessions where user_id = new.user_id and seconds > 0
    );
  else
    delta := new.seconds - old.seconds;
    had_listened := old.seconds > 0 or exists (
      select 1 from public.reading_sessions
      where user_id = new.user_id and seconds > 0 and id <> new.id
    );
  end if;
  if delta <> 0 then
    update public.reading_stats
      set total_seconds = greatest(0, total_seconds + delta), updated_at = now()
      where id = 1;
  end if;
  if new.seconds > 0 and not had_listened then
    update public.reading_stats set readers = readers + 1, updated_at = now() where id = 1;
  end if;
  new.updated_at = now();
  return new;
end $$;

-- Rebuild the totals from what was actually listened to.
update public.reading_stats
set total_seconds = coalesce((select sum(seconds) from public.reading_sessions), 0),
    readers = (select count(distinct user_id) from public.reading_sessions where seconds > 0),
    updated_at = now()
where id = 1;
