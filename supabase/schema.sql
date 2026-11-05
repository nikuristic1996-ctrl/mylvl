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

create policy "profiles are private to their owner" on public.profiles for all to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
create policy "activities are private to their owner" on public.activities for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
-- Award writes should be performed by a trusted server-side flow so clients
-- cannot grant themselves XP by inserting arbitrary transactions.
create policy "experience is readable by its owner" on public.experience_transactions for select to authenticated
  using (user_id = (select auth.uid()));
create policy "progress is readable by its owner" on public.user_progress for select to authenticated
  using (user_id = (select auth.uid()));
create policy "integrations are private to their owner" on public.integrations for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

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
