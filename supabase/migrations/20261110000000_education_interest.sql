-- Schools that asked to hear about Aloud for Education. Written only through
-- submit_education_interest, read only from the dashboard or the service
-- role: RLS is on with no policies, so the anon and authenticated roles can
-- neither select nor insert directly.
create table if not exists public.education_interest (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 254),
  institution text not null check (char_length(institution) between 1 and 200),
  role text not null check (char_length(role) <= 80),
  size text check (char_length(size) <= 40),
  message text check (char_length(message) <= 2000),
  user_agent text check (char_length(user_agent) <= 300)
);

alter table public.education_interest enable row level security;

create or replace function public.submit_education_interest(
  p_name text,
  p_email text,
  p_institution text,
  p_role text,
  p_size text default null,
  p_message text default null,
  p_user_agent text default null
) returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.education_interest (name, email, institution, role, size, message, user_agent)
  values (p_name, lower(p_email), p_institution, p_role, p_size, p_message, p_user_agent);
$$;

revoke all on function public.submit_education_interest(text, text, text, text, text, text, text) from public;
grant execute on function public.submit_education_interest(text, text, text, text, text, text, text) to anon, authenticated;
