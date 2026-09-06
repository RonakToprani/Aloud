-- The listening total was being counted twice. The delta trigger ran BEFORE
-- INSERT OR UPDATE, and an upsert (the client's periodic "here is this
-- session's running total") fires BEFORE INSERT with the whole value and
-- then, on conflict, BEFORE UPDATE with the delta. AFTER triggers don't have
-- that flaw: a conflicting upsert fires only AFTER UPDATE.

create or replace function public.apply_session_delta()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  delta integer;
  had_listened boolean;
begin
  if tg_op = 'INSERT' then
    delta := new.seconds;
    had_listened := exists (
      select 1 from public.reading_sessions
      where user_id = new.user_id and seconds > 0 and id <> new.id
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
  return null;
end $$;

drop trigger if exists reading_sessions_delta on public.reading_sessions;
create trigger reading_sessions_delta
  after insert or update on public.reading_sessions
  for each row execute function public.apply_session_delta();

drop trigger if exists reading_sessions_updated_at on public.reading_sessions;
create trigger reading_sessions_updated_at
  before insert or update on public.reading_sessions
  for each row execute function public.set_updated_at();

-- Rebuild the totals from what was actually listened to.
update public.reading_stats
set total_seconds = coalesce((select sum(seconds) from public.reading_sessions), 0),
    readers = (select count(distinct user_id) from public.reading_sessions where seconds > 0),
    updated_at = now()
where id = 1;
