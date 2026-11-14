begin;

-- A draft schedule is stored with no start date and remains disabled until
-- the owner explicitly activates it with an approved UTC timestamp.
create table if not exists public.season_schedule_config (
  singleton boolean primary key default true check (singleton),
  first_start_at timestamptz,
  first_season_name text not null default 'Season 01 – Find Your Rhythm',
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint season_schedule_enabled_has_start check (not enabled or first_start_at is not null)
);
insert into public.season_schedule_config(singleton, first_start_at, first_season_name, enabled)
values (true, null, 'Season 01 – Find Your Rhythm', false)
on conflict (singleton) do nothing;
alter table public.season_schedule_config enable row level security;
revoke all on public.season_schedule_config from public, anon, authenticated;

create table if not exists public.season_reward_catalog (
  reward_key text primary key,
  name text not null,
  description text not null,
  reward_type text not null check (reward_type in ('outfit','profile_frame','title','badge','visual_effect')),
  milestone_exp bigint not null check (milestone_exp >= 0),
  visual_config jsonb not null default '{}'::jsonb check (jsonb_typeof(visual_config) = 'object'),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.season_reward_catalog(reward_key, name, description, reward_type, milestone_exp, visual_config, sort_order)
values
  ('rhythm-seeker-title', 'Rhythm Seeker', 'A title for building a steady habit.', 'title', 2500, '{"style":"lime"}'::jsonb, 1),
  ('silver-spark-badge', 'Silver Spark', 'A badge earned at the Silver milestone.', 'badge', 5000, '{"style":"silver"}'::jsonb, 2),
  ('gold-halo-frame', 'Gold Halo', 'A profile frame earned at the Gold milestone.', 'profile_frame', 10000, '{"style":"gold"}'::jsonb, 3),
  ('platinum-flow-outfit', 'Platinum Flow', 'An outfit reward for reaching Platinum.', 'outfit', 15000, '{"style":"platinum"}'::jsonb, 4),
  ('diamond-trail-effect', 'Diamond Trail', 'A visual effect earned at the Diamond milestone.', 'visual_effect', 20000, '{"style":"diamond"}'::jsonb, 5)
on conflict (reward_key) do nothing;

create table if not exists public.user_cosmetic_rewards (
  user_id uuid not null references auth.users(id) on delete cascade,
  reward_key text not null references public.season_reward_catalog(reward_key) on delete restrict,
  season_id uuid not null references public.seasons(id) on delete restrict,
  season_exp_at_unlock bigint not null check (season_exp_at_unlock >= 0),
  unlocked_at timestamptz not null default now(),
  primary key (user_id, reward_key)
);
create index if not exists user_cosmetic_rewards_user_time_idx
  on public.user_cosmetic_rewards(user_id, unlocked_at desc);
alter table public.season_reward_catalog enable row level security;
alter table public.user_cosmetic_rewards enable row level security;
drop policy if exists "Season reward catalog is readable by signed-in users" on public.season_reward_catalog;
create policy "Season reward catalog is readable by signed-in users"
  on public.season_reward_catalog for select to authenticated using (true);
drop policy if exists "Cosmetic rewards are private to their owner" on public.user_cosmetic_rewards;
create policy "Cosmetic rewards are private to their owner"
  on public.user_cosmetic_rewards for select to authenticated
  using ((select auth.uid()) = user_id);
revoke all on public.season_reward_catalog, public.user_cosmetic_rewards from public, anon, authenticated;
grant select on public.season_reward_catalog, public.user_cosmetic_rewards to authenticated;

-- The same 12-week UTC schedule is generated transactionally when an award is
-- reserved. It uses receipt time, so late imports never backfill an expired season.
create or replace function public.resolve_activity_award_season()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_enabled boolean;
  v_anchor timestamptz;
  v_first_name text;
  v_index integer;
  v_number integer;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_key text;
  v_name text;
  v_season_id uuid;
begin
  select enabled, first_start_at, first_season_name
    into v_enabled, v_anchor, v_first_name
    from public.season_schedule_config where singleton = true;
  if not coalesce(v_enabled, false) or v_anchor is null or now() < v_anchor then
    new.season_id := null;
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(731904210);
  v_index := floor(extract(epoch from (now() - v_anchor)) / 7257600)::integer + 1;
  if v_index < 1 or v_index > 500 then
    raise exception 'Season schedule is outside the supported 500-season range';
  end if;

  for v_number in 1..v_index loop
    v_starts_at := v_anchor + ((v_number - 1) * interval '2016 hours');
    v_ends_at := v_starts_at + interval '2016 hours';
    v_key := 'season-' || pg_catalog.lpad(v_number::text, 2, '0');
    v_name := case when v_number = 1 then v_first_name
      else 'Season ' || pg_catalog.lpad(v_number::text, 2, '0') end;
    insert into public.seasons(season_key, name, starts_at, ends_at)
      values (v_key, v_name, v_starts_at, v_ends_at)
      on conflict (season_key) do nothing;
  end loop;

  select id into v_season_id from public.seasons
    where starts_at <= now() and now() < ends_at
    order by starts_at desc limit 1;
  if v_season_id is null then
    raise exception 'No season window is available for the current UTC time';
  end if;

  perform public.archive_ended_seasons();
  new.season_id := v_season_id;
  return new;
end;
$$;
revoke all on function public.resolve_activity_award_season() from public, anon, authenticated;
drop trigger if exists resolve_season_before_award_reservation on public.activity_award_attempts;
create trigger resolve_season_before_award_reservation
  before insert on public.activity_award_attempts
  for each row execute procedure public.resolve_activity_award_season();

-- Owner-only RPC to materialize completed history when the user opens the app,
-- even if they logged no activity near the season boundary.
create or replace function public.archive_my_ended_seasons()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer;
begin
  if v_user_id is null then raise exception 'Authentication is required'; end if;
  insert into public.season_history(
    user_id, season_id, season_key, season_name, starts_at, ends_at, season_exp, season_level, season_rank
  )
  select sp.user_id, s.id, s.season_key, s.name, s.starts_at, s.ends_at, sp.season_exp, sp.season_level, sp.season_rank
  from public.season_progress sp
  join public.seasons s on s.id = sp.season_id
  where sp.user_id = v_user_id and s.ends_at <= now()
  on conflict (user_id, season_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.archive_my_ended_seasons() from public, anon, authenticated;
grant execute on function public.archive_my_ended_seasons() to authenticated;

-- First-season activation is a distinct owner-authorized operation. This
-- migration only prepares the disabled configuration and never chooses a date.
create or replace function public.activate_first_season(p_first_start_at timestamptz)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_config public.season_schedule_config%rowtype;
  v_season_id uuid;
  v_ends_at timestamptz;
begin
  if p_first_start_at is null then raise exception 'A UTC start timestamp is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(731904210);
  select * into v_config from public.season_schedule_config where singleton = true for update;
  if v_config.enabled then raise exception 'The first season has already been activated'; end if;
  if p_first_start_at < now() - interval '1 day' or p_first_start_at > now() + interval '365 days' then
    raise exception 'Start time must be within the next 365 days (or at most one day in the past)';
  end if;
  if exists (select 1 from public.seasons) then
    raise exception 'Existing season windows prevent first-season activation';
  end if;
  v_ends_at := p_first_start_at + interval '2016 hours';
  update public.season_schedule_config
    set first_start_at = p_first_start_at, enabled = true, updated_at = now()
    where singleton = true;
  insert into public.seasons(season_key, name, starts_at, ends_at)
    values ('season-01', v_config.first_season_name, p_first_start_at, v_ends_at)
    returning id into v_season_id;
  return v_season_id;
end;
$$;
revoke all on function public.activate_first_season(timestamptz) from public, anon, authenticated;
grant execute on function public.activate_first_season(timestamptz) to service_role;

create or replace function public.grant_season_cosmetic_rewards()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.user_cosmetic_rewards(user_id, reward_key, season_id, season_exp_at_unlock)
  select new.user_id, reward.reward_key, new.season_id, new.season_exp
  from public.season_reward_catalog reward
  where reward.active and reward.milestone_exp <= new.season_exp
  on conflict (user_id, reward_key) do nothing;
  return new;
end;
$$;
revoke all on function public.grant_season_cosmetic_rewards() from public, anon, authenticated;
drop trigger if exists grant_cosmetic_rewards_after_season_progress on public.season_progress;
create trigger grant_cosmetic_rewards_after_season_progress
  after insert or update of season_exp on public.season_progress
  for each row execute procedure public.grant_season_cosmetic_rewards();

-- Authenticated callers can read only their own rows through the existing
-- RLS policies. The function takes no user id, preventing cross-account queries.
create or replace function public.get_my_progression_stats()
returns jsonb language sql stable security invoker set search_path = '' as $$
  with caller as (
    select (select auth.uid()) as user_id
  ),
  tx_by_activity as (
    select tx.user_id, tx.activity_id, sum(tx.exp_amount)::bigint as xp
    from public.experience_transactions tx
    where tx.user_id = (select user_id from caller) and tx.activity_id is not null
    group by tx.user_id, tx.activity_id
  ),
  my_activities as (
    select a.id, a.user_id, a.activity_type, a.activity_date, a.distance_km, a.distance, a.steps,
      a.validation_status, a.notes, coalesce(tx.xp, 0)::bigint as xp
    from public.activities a
    left join tx_by_activity tx on tx.user_id = a.user_id and tx.activity_id = a.id
    where a.user_id = (select user_id from caller)
  ),
  daily as (
    select (a.activity_date at time zone 'UTC')::date as activity_day,
      count(*)::integer as activity_count, sum(a.xp)::bigint as xp
    from my_activities a
    group by (a.activity_date at time zone 'UTC')::date
  ),
  weekly_days as (
    select series.day::date as day
    from pg_catalog.generate_series(
      (pg_catalog.timezone('UTC', now())::date - 6)::timestamp,
      pg_catalog.timezone('UTC', now())::date::timestamp,
      interval '1 day'
    ) as series(day)
  ),
  month_starts as (
    select series.month_start
    from pg_catalog.generate_series(
      pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', now())) - interval '5 months',
      pg_catalog.date_trunc('month', pg_catalog.timezone('UTC', now())),
      interval '1 month'
    ) as series(month_start)
  ),
  monthly as (
    select pg_catalog.date_trunc('month', a.activity_date at time zone 'UTC') as month_start,
      count(*)::integer as activity_count, sum(a.xp)::bigint as xp
    from my_activities a
    group by pg_catalog.date_trunc('month', a.activity_date at time zone 'UTC')
  )
  select pg_catalog.jsonb_build_object(
    'totalActivities', (select count(*) from my_activities),
    'runningDistanceKm', coalesce((select sum(coalesce(distance_km, distance, 0)) from my_activities where activity_type = 'Running'), 0),
    'measuredRunningSteps', coalesce((select sum(steps) from my_activities where activity_type = 'Running' and steps is not null
      and (validation_status = 'provider_verified' or coalesce(notes, '') ~* 'Steps source: measured')), 0),
    'estimatedRunningSteps', coalesce((select sum(steps) from my_activities where activity_type = 'Running' and steps is not null
      and coalesce(notes, '') ~* 'Steps source: estimated'), 0),
    'xpByActivityType', coalesce((select pg_catalog.jsonb_object_agg(activity_type, xp_total)
      from (select activity_type, sum(xp)::bigint as xp_total from my_activities group by activity_type) grouped), '{}'::jsonb),
    'weeklyTrend', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'period', pg_catalog.to_char(days.day, 'YYYY-MM-DD'),
      'activities', coalesce(daily.activity_count, 0), 'xp', coalesce(daily.xp, 0)
    ) order by days.day)
      from weekly_days days left join daily on daily.activity_day = days.day), '[]'::jsonb),
    'monthlyTrend', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'period', pg_catalog.to_char(months.month_start, 'YYYY-MM'),
      'activities', coalesce(monthly.activity_count, 0), 'xp', coalesce(monthly.xp, 0)
    ) order by months.month_start)
      from month_starts months left join monthly on monthly.month_start = months.month_start), '[]'::jsonb)
  );
$$;
revoke all on function public.get_my_progression_stats() from public, anon, authenticated;
grant execute on function public.get_my_progression_stats() to authenticated;

commit;

