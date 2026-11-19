-- Disposable pre-Phase-6 schema fixture, based on the existing MYLVL production catalog.
-- Synthetic rows are used only to assert the camera migration preserves existing data.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create function public.canonical_activity_type(p_activity_type text)
returns text language sql immutable set search_path = ''
as $$
  select case regexp_replace(lower(btrim(coalesce(p_activity_type, ''))), '[[:space:]_-]+', '', 'g')
    when 'walking' then 'walking' when 'running' then 'running' when 'cycling' then 'cycling'
    when 'swimming' then 'swimming' when 'strength' then 'strength' when 'yoga' then 'yoga'
    when 'pilates' then 'pilates' when 'pushups' then 'pushups' when 'squats' then 'squats'
    when 'situps' then 'situps' when 'plank' then 'plank' when 'pullups' then 'pullups'
    else null end
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null default 'Adventurer',
  timezone text not null default 'UTC'
);
create table public.seasons (
  id uuid primary key default gen_random_uuid(),
  season_key text not null unique,
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null
);
create table public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_type text not null,
  duration integer not null,
  duration_minutes numeric(10,2) not null default 1,
  activity_date timestamptz not null,
  source text not null default 'manual',
  source_key text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  validation_status text not null default 'legacy_unreviewed',
  validation_method text,
  validation_confidence numeric(5,4),
  validation_deviation_percent numeric(8,3),
  request_key uuid,
  repetitions integer,
  constraint activities_source_check check (source in ('manual','screenshot','apple_health','health_connect','garmin','strava')),
  constraint activities_activity_type_check check (activity_type in ('Running','running','pushups','squats')),
  constraint activities_user_source_key_key unique (user_id,source,source_key)
);
create table public.experience_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid references public.activities(id) on delete set null,
  transaction_type text not null,
  exp_amount integer not null check(exp_amount > 0),
  created_at timestamptz not null default now()
);
create table public.activity_award_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null unique references public.activities(id) on delete cascade,
  request_key uuid not null,
  activity_type text not null,
  metric_type text not null,
  local_date date not null,
  metric_amount numeric(12,3) not null default 0,
  daily_metric_before numeric(12,3) not null default 0,
  counts_toward_cap boolean not null default false,
  season_id uuid references public.seasons(id) on delete restrict,
  status text not null,
  result_xp integer not null default 0,
  transaction_id uuid references public.experience_transactions(id) on delete set null,
  result_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique(user_id,request_key)
);

alter table public.profiles enable row level security;
alter table public.activities enable row level security;
alter table public.activity_award_attempts enable row level security;
create policy "profiles are private to their owner" on public.profiles
  for all to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "activities are readable by their owner" on public.activities
  for select to authenticated using (user_id = (select auth.uid()));
create policy "activities are deletable by their owner" on public.activities
  for delete to authenticated using (user_id = (select auth.uid()));
create policy "Award attempts are private to their owner" on public.activity_award_attempts
  for select to authenticated using (user_id = (select auth.uid()));
grant usage on schema public, auth to authenticated;
grant select, delete on public.activities to authenticated;
grant select on public.profiles, public.activity_award_attempts to authenticated;

insert into auth.users(id) values ('11111111-1111-4111-8111-111111111111');
insert into public.profiles(id,username,timezone)
values ('11111111-1111-4111-8111-111111111111','CI existing user','Europe/Zurich');
insert into public.activities(id,user_id,activity_type,duration,duration_minutes,activity_date,source,source_key,validation_status)
values ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','Running',30,30,'2026-11-01T10:00:00Z','screenshot','baseline-activity','user_confirmed');
insert into public.experience_transactions(id,user_id,activity_id,transaction_type,exp_amount)
values ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','activity',720);
insert into public.activity_award_attempts(
 id,user_id,activity_id,request_key,activity_type,metric_type,local_date,metric_amount,
 daily_metric_before,counts_toward_cap,status,result_xp,transaction_id
) values (
 '44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111',
 '22222222-2222-4222-8222-222222222222','55555555-5555-4555-8555-555555555555',
 'running','distanceKm','2026-11-01',5,0,true,'awarded',720,'33333333-3333-4333-8333-333333333333'
);
