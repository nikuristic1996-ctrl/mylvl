-- mylvl foundation schema. Run in the Supabase SQL editor for a new project.
-- Authenticated users can only read or write rows carrying their own auth.uid().
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null default 'Adventurer' check (char_length(username) between 1 and 32),
  avatar_configuration jsonb not null default '{"hair":"#b7f56a","skin":"#d89b73","outfit":"#a893ff"}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_type text not null check (activity_type in ('Walking','Running','Strength','Bodyweight','Yoga','Pilates','Cycling','Swimming','Other')),
  duration integer not null check (duration > 0),
  distance numeric(8,2) check (distance is null or distance >= 0),
  steps integer check (steps is null or steps >= 0),
  calories integer check (calories is null or calories >= 0),
  repetitions integer check (repetitions is null or repetitions >= 0),
  activity_date timestamptz not null,
  source text not null default 'manual' check (source in ('manual','screenshot','apple_health','health_connect','garmin','strava')),
  source_key text,
  notes text check (notes is null or char_length(notes) <= 500),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, source, source_key)
);
create index if not exists activities_user_date_idx on public.activities(user_id, activity_date desc);

-- Server-side XP rates are the source of truth for awarded XP.
create table if not exists public.experience_rules (
  activity_type text primary key check (activity_type in ('Walking','Running','Strength','Bodyweight','Yoga','Pilates','Cycling','Swimming','Other')),
  base_exp integer not null check (base_exp >= 0),
  exp_per_minute numeric(6,2) not null check (exp_per_minute >= 0)
);
insert into public.experience_rules (activity_type, base_exp, exp_per_minute) values
  ('Walking',12,1.10),('Running',25,2.10),('Strength',22,1.70),('Bodyweight',16,1.50),
  ('Yoga',14,1.20),('Pilates',16,1.30),('Cycling',20,1.60),('Swimming',24,1.90),('Other',10,1.00)
on conflict (activity_type) do nothing;

create table if not exists public.experience_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid references public.activities(id) on delete set null,
  exp_amount integer not null check (exp_amount > 0),
  transaction_type text not null check (transaction_type in ('activity','bonus','adjustment')),
  idempotency_key text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index if not exists experience_user_created_idx on public.experience_transactions(user_id, created_at desc);

create table if not exists public.user_progress (
  user_id uuid primary key references auth.users(id) on delete cascade,
  total_exp bigint not null default 0 check (total_exp >= 0),
  current_level integer not null default 1 check (current_level >= 1),
  updated_at timestamptz not null default now()
);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('apple_health','health_connect','garmin','strava')),
  connection_status text not null default 'disconnected' check (connection_status in ('disconnected','pending','connected','error')),
  provider_user_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

alter table public.profiles enable row level security;
alter table public.activities enable row level security;
alter table public.experience_transactions enable row level security;
alter table public.user_progress enable row level security;
alter table public.integrations enable row level security;
alter table public.experience_rules enable row level security;

drop policy if exists "profiles are private to their owner" on public.profiles;
drop policy if exists "activities are private to their owner" on public.activities;
drop policy if exists "experience is readable by its owner" on public.experience_transactions;
drop policy if exists "progress is readable by its owner" on public.user_progress;
drop policy if exists "integrations are private to their owner" on public.integrations;
drop policy if exists "experience rules are readable" on public.experience_rules;
create policy "profiles are private to their owner" on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "activities are readable by their owner" on public.activities for select to authenticated
  using (user_id = (select auth.uid()));
create policy "activities are deletable by their owner" on public.activities for delete to authenticated
  using (user_id = (select auth.uid()));
-- Award writes should be performed by a trusted server-side flow so clients
-- cannot grant themselves XP by inserting arbitrary transactions.
create policy "experience is readable by its owner" on public.experience_transactions for select to authenticated
  using (user_id = (select auth.uid()));
create policy "progress is readable by its owner" on public.user_progress for select to authenticated
  using (user_id = (select auth.uid()));
create policy "integrations are private to their owner" on public.integrations for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "experience rules are readable" on public.experience_rules for select to authenticated using (true);

revoke all on public.profiles, public.activities, public.experience_transactions, public.user_progress,
  public.integrations, public.experience_rules from anon, authenticated;
grant select on public.profiles to authenticated;
grant update (username, avatar_configuration) on public.profiles to authenticated;
grant select, delete on public.activities to authenticated;
grant select on public.experience_transactions, public.user_progress, public.experience_rules to authenticated;
grant select, insert, update, delete on public.integrations to authenticated;

create or replace function public.calculate_activity_exp(p_activity_type text, p_duration integer)
returns integer language sql stable security definer set search_path = '' as $$
  select round(r.base_exp + greatest(0, p_duration) * r.exp_per_minute)::integer
  from public.experience_rules r where r.activity_type = p_activity_type
$$;

create or replace function public.apply_experience_transaction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_total bigint;
  v_level integer := 1;
  v_remaining bigint;
  v_needed integer := 250;
begin
  insert into public.user_progress (user_id, total_exp, current_level)
  values (new.user_id, new.exp_amount, 1)
  on conflict (user_id) do update set total_exp = public.user_progress.total_exp + new.exp_amount, updated_at = now()
  returning total_exp into v_total;
  v_remaining := v_total;
  while v_remaining >= v_needed loop
    v_remaining := v_remaining - v_needed;
    v_level := v_level + 1;
    v_needed := round(250 + v_level * 85)::integer;
  end loop;
  update public.user_progress set current_level = v_level, updated_at = now() where user_id = new.user_id;
  return new;
end;
$$;
drop trigger if exists on_experience_transaction_created on public.experience_transactions;
create trigger on_experience_transaction_created after insert on public.experience_transactions
  for each row execute procedure public.apply_experience_transaction();

create or replace function public.record_activity(p_activity jsonb)
returns table(activity_id uuid, exp_amount integer, duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid;
  v_xp integer;
  v_type text := p_activity ->> 'activity_type';
  v_duration integer := (p_activity ->> 'duration')::integer;
  v_source text := coalesce(p_activity ->> 'source', 'manual');
  v_source_key text := nullif(p_activity ->> 'source_key', '');
begin
  if v_user_id is null then raise exception 'Authentication required'; end if;
  if v_source not in ('manual','screenshot') then raise exception 'Unsupported activity source'; end if;
  v_xp := public.calculate_activity_exp(v_type, v_duration);
  if v_xp is null then raise exception 'Unsupported activity type'; end if;
  insert into public.activities (user_id, activity_type, duration, distance, steps, calories, repetitions,
    activity_date, source, source_key, notes)
  values (v_user_id, v_type, v_duration, nullif(p_activity ->> 'distance','')::numeric,
    nullif(p_activity ->> 'steps','')::integer, nullif(p_activity ->> 'calories','')::integer,
    nullif(p_activity ->> 'repetitions','')::integer, (p_activity ->> 'activity_date')::timestamptz,
    v_source, v_source_key, nullif(p_activity ->> 'notes',''))
  on conflict (user_id, source, source_key) do nothing returning id into v_id;
  if v_id is null then
    select a.id, t.exp_amount into v_id, v_xp
    from public.activities a left join public.experience_transactions t on t.activity_id = a.id
    where a.user_id = v_user_id and a.source = v_source and a.source_key = v_source_key limit 1;
    return query select v_id, coalesce(v_xp, 0), true;
    return;
  end if;
  insert into public.experience_transactions (user_id, activity_id, exp_amount, transaction_type, idempotency_key)
  values (v_user_id, v_id, v_xp, 'activity', 'activity:' || v_id::text);
  return query select v_id, v_xp, false;
end;
$$;
revoke all on function public.calculate_activity_exp(text, integer) from public, anon;
revoke all on function public.record_activity(jsonb) from public, anon;
grant execute on function public.record_activity(jsonb) to authenticated;

create or replace function public.create_profile_for_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username) values (new.id, coalesce(new.raw_user_meta_data ->> 'username', 'Adventurer'));
  insert into public.user_progress (user_id) values (new.id);
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute procedure public.create_profile_for_user();
