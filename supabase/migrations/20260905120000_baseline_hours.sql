-- A baseline added to the public listening total.
--
-- Aloud was in use before listening time was recorded at all, so the counter
-- started from zero on a product that had already been read from. This row's
-- baseline is an estimate of that earlier reading. It is kept apart from the
-- measured total so it can be revised or removed without touching real data:
--
--   update public.reading_stats set baseline_seconds = 0 where id = 1;

alter table public.reading_stats
  add column if not exists baseline_seconds bigint not null default 0;

update public.reading_stats set baseline_seconds = 30 * 3600, updated_at = now() where id = 1;

create or replace function public.public_stats()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'total_seconds', s.total_seconds + s.baseline_seconds,
    'measured_seconds', s.total_seconds,
    'readers', s.readers,
    'active_readers', (
      select count(distinct user_id) from public.reading_sessions
      where updated_at > now() - interval '7 days'
    ),
    'updated_at', s.updated_at
  )
  from public.reading_stats s where s.id = 1;
$$;
