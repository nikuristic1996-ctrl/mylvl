-- Phase 2: additive data model and transaction-safe progression.
-- This migration does not delete application data and does not seed a season.
begin;

alter table public.profiles
  add column if not exists timezone text not null default 'UTC';

alter table public.activities
  add column if not exists duration_minutes numeric(10,2),
  add column if not exists distance_km numeric(10,3),
  add column if not exists distance_meters numeric(12,2),
  add column if not exists active_calories numeric(10,2),
  add column if not exists hold_seconds numeric(10,2),
  add column if not exists validation_status text not null default 'legacy_unreviewed',
  add column if not exists validation_method text,
  add column if not exists validation_confidence numeric(5,4),
  add column if not exists validation_deviation_percent numeric(8,3),
  add column if not exists request_key uuid,
  add column if not exists exp_rule_version text;

-- Preserve existing records and normalize their duration only; do not grant retroactive EXP.
update public.activities set duration_minutes = duration where duration_minutes is null;
alter table public.activities alter column duration_minutes set not null;
alter table public.activities alter column duration_minutes set default 1;
alter table public.activities
  add constraint activities_duration_minutes_positive check (duration_minutes > 0),
  add constraint activities_validation_status_check check (validation_status in (
    'unverified','user_confirmed','provider_verified','pose_validated',
    'pending_review','rejected','demo','legacy_unreviewed'
  )),
  add constraint activities_validation_confidence_check check (
    validation_confidence is null or validation_confidence between 0 and 1
  ),
  add constraint activities_validation_deviation_check check (
    validation_deviation_percent is null or validation_deviation_percent >= 0
  );

alter table public.activities drop constraint if exists activities_activity_type_check;
alter table public.activities add constraint activities_activity_type_check check (activity_type in (
  'Walking','Running','Strength','Bodyweight','Yoga','Pilates','Cycling','Swimming','Other',
  'walking','running','cycling','swimming','strength','yoga','pilates',
  'pushups','squats','situps','plank','pullups'
));
create unique index if not exists activities_user_request_key_idx
  on public.activities(user_id, request_key) where request_key is not null;

alter table public.experience_transactions
  add column if not exists rule_version text,
  add column if not exists season_id uuid;
alter table public.experience_transactions
  drop constraint if exists experience_transactions_transaction_type_check;
alter table public.experience_transactions add constraint experience_transactions_transaction_type_check
  check (transaction_type in ('activity','bonus','adjustment','step_settlement'));
create unique index if not exists experience_transactions_one_activity_award_idx
  on public.experience_transactions(activity_id)
  where activity_id is not null and transaction_type = 'activity';

create table if not exists public.exp_rule_versions (
  version text primary key,
  description text not null,
  rules_json jsonb not null,
  created_at timestamptz not null default now()
);
insert into public.exp_rule_versions(version, description, rules_json)
values (
  '1.0.0',
  'Initial game-engine rules mirrored for audit history; runtime EXP is calculated by the shared TypeScript engine.',
  '{
    "running":{"metric":"distanceKm","unitSize":1,"xpPerUnit":100,"dailyCap":30,"afterCapMultiplier":0.5},
    "walking":{"metric":"steps","unitSize":1000,"xpPerUnit":50,"dailyCap":20000,"afterCapMultiplier":0.25},
    "cycling":{"metric":"distanceKm","unitSize":1,"xpPerUnit":20,"dailyCap":100,"afterCapMultiplier":0.5},
    "swimming":{"metric":"distanceMeters","unitSize":100,"xpPerUnit":50,"dailyCap":5000,"afterCapMultiplier":0.5},
    "strength":{"metric":"durationMinutes","unitSize":10,"xpPerUnit":30,"dailyCap":120,"afterCapMultiplier":0.25,"intensityMultipliers":[0.75,1,1.2,1.4],"missingActiveCaloriesMultiplier":1},
    "yoga":{"metric":"durationMinutes","unitSize":10,"xpPerUnit":20,"dailyCap":120,"afterCapMultiplier":0.25},
    "pilates":{"metric":"durationMinutes","unitSize":10,"xpPerUnit":20,"dailyCap":120,"afterCapMultiplier":0.25},
    "pushups":{"metric":"repetitions","unitSize":1,"xpPerUnit":5,"dailyCap":100,"afterCapMultiplier":0.25},
    "squats":{"metric":"repetitions","unitSize":1,"xpPerUnit":3,"dailyCap":150,"afterCapMultiplier":0.25},
    "situps":{"metric":"repetitions","unitSize":1,"xpPerUnit":2,"dailyCap":150,"afterCapMultiplier":0.25},
    "plank":{"metric":"holdSeconds","unitSize":10,"xpPerUnit":6,"dailyCap":600,"afterCapMultiplier":0.25},
    "pullups":{"metric":"repetitions","unitSize":1,"xpPerUnit":8,"dailyCap":50,"afterCapMultiplier":0.25},
    "exerciseValidation":{"maximumEstimateDeviationPercent":10,"minimumPoseConfidence":0.7}
  }'::jsonb
)
on conflict (version) do nothing;

create table if not exists public.seasons (
  id uuid primary key default gen_random_uuid(),
  season_key text not null unique,
  name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint seasons_window_12_weeks check (ends_at = starts_at + interval '2016 hours'),
  constraint seasons_window_order check (ends_at > starts_at)
);

create or replace function public.prevent_overlapping_seasons()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- Serialize schedule edits so two concurrent inserts cannot create an overlap.
  perform pg_catalog.pg_advisory_xact_lock(731904210);
  if exists (
    select 1 from public.seasons s
    where s.id is distinct from new.id
      and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(new.starts_at, new.ends_at, '[)')
  ) then
    raise exception 'Season windows cannot overlap';
  end if;
  return new;
end;
$$;
drop trigger if exists seasons_no_overlap on public.seasons;
create trigger seasons_no_overlap before insert or update of starts_at, ends_at
  on public.seasons for each row execute procedure public.prevent_overlapping_seasons();

create table if not exists public.permanent_level_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  level integer not null check (level >= 1),
  total_exp_at_level bigint not null check (total_exp_at_level >= 0),
  source text not null check (source in ('earned','migration_baseline')),
  reached_at timestamptz not null default now(),
  unique (user_id, level)
);
create index if not exists permanent_level_history_user_time_idx
  on public.permanent_level_history(user_id, reached_at desc);

create table if not exists public.season_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete restrict,
  season_exp bigint not null default 0 check (season_exp >= 0),
  season_level integer not null default 1 check (season_level between 1 and 50),
  season_rank text not null default 'Bronze'
    check (season_rank in ('Bronze','Silver','Gold','Platinum','Diamond')),
  updated_at timestamptz not null default now(),
  primary key (user_id, season_id)
);

create table if not exists public.season_history (
  user_id uuid not null references auth.users(id) on delete cascade,
  season_id uuid not null references public.seasons(id) on delete restrict,
  season_key text not null,
  season_name text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  season_exp bigint not null check (season_exp >= 0),
  season_level integer not null check (season_level between 1 and 50),
  season_rank text not null check (season_rank in ('Bronze','Silver','Gold','Platinum','Diamond')),
  archived_at timestamptz not null default now(),
  primary key (user_id, season_id)
);
create index if not exists season_history_user_time_idx
  on public.season_history(user_id, ends_at desc);

create table if not exists public.daily_step_settlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  timezone text not null,
  total_steps integer check (total_steps is null or total_steps >= 0),
  running_session_steps integer check (running_session_steps is null or running_session_steps >= 0),
  eligible_steps integer check (eligible_steps is null or eligible_steps >= 0),
  status text not null default 'pending'
    check (status in ('pending','reconciled','settled','needs_reconciliation','invalid')),
  idempotency_key text not null,
  transaction_id uuid,
  synced_at timestamptz,
  settled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, local_date),
  unique (user_id, idempotency_key)
);

create table if not exists public.activity_duplicate_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  candidate_activity_id uuid references public.activities(id) on delete set null,
  classification text not null check (classification in ('confirmed_duplicate','possible_duplicate','unique')),
  confidence numeric(5,4) check (confidence is null or confidence between 0 and 1),
  signals jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (activity_id, candidate_activity_id)
);

create table if not exists public.activity_award_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null unique references public.activities(id) on delete cascade,
  request_key uuid not null,
  activity_type text not null check (activity_type in (
    'walking','running','cycling','swimming','strength','yoga','pilates',
    'pushups','squats','situps','plank','pullups'
  )),
  metric_type text not null,
  local_date date not null,
  metric_amount numeric(12,3) not null default 0 check (metric_amount >= 0),
  daily_metric_before numeric(12,3) not null default 0 check (daily_metric_before >= 0),
  counts_toward_cap boolean not null default false,
  season_id uuid references public.seasons(id) on delete restrict,
  status text not null check (status in ('pending','awarded','ineligible','requires_review','expired')),
  result_xp integer not null default 0 check (result_xp >= 0),
  transaction_id uuid,
  result_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finalized_at timestamptz,
  unique (user_id, request_key)
);
create index if not exists activity_award_daily_lock_idx
  on public.activity_award_attempts(user_id, local_date, activity_type, status);

alter table public.experience_transactions
  add constraint experience_transactions_rule_version_fkey
    foreign key (rule_version) references public.exp_rule_versions(version) on delete restrict,
  add constraint experience_transactions_season_fkey
    foreign key (season_id) references public.seasons(id) on delete restrict;
alter table public.daily_step_settlements
  add constraint daily_step_transaction_fkey
    foreign key (transaction_id) references public.experience_transactions(id) on delete set null;
alter table public.activity_award_attempts
  add constraint activity_award_transaction_fkey
    foreign key (transaction_id) references public.experience_transactions(id) on delete set null;

create or replace function public.permanent_level_for_exp(p_total_exp bigint)
returns integer language sql immutable set search_path = '' as $$
  select greatest(1, floor((sqrt(225625::numeric + 100::numeric * greatest(coalesce(p_total_exp, 0), 0)) - 475) / 50)::integer + 1)
$$;

create or replace function public.permanent_xp_threshold(p_level integer)
returns bigint language sql immutable set search_path = '' as $$
  select (500::numeric * (p_level - 1) + 25::numeric * (p_level - 1) * (p_level - 2))::bigint
  where p_level >= 1
$$;

create or replace function public.season_level_for_exp(p_season_exp bigint)
returns integer language sql immutable set search_path = '' as $$
  select least(50, floor(greatest(coalesce(p_season_exp, 0), 0)::numeric / 500)::integer + 1)
$$;

create or replace function public.season_rank_for_exp(p_season_exp bigint)
returns text language sql immutable set search_path = '' as $$
  select case
    when coalesce(p_season_exp, 0) >= 20000 then 'Diamond'
    when coalesce(p_season_exp, 0) >= 15000 then 'Platinum'
    when coalesce(p_season_exp, 0) >= 10000 then 'Gold'
    when coalesce(p_season_exp, 0) >= 5000 then 'Silver'
    else 'Bronze'
  end
$$;

-- One canonical form is used for all new awards, locks, caps and duplicate checks.
create or replace function public.canonical_activity_type(p_activity_type text)
returns text language sql immutable set search_path = '' as $$
  select case regexp_replace(lower(btrim(coalesce(p_activity_type, ''))), '[[:space:]_-]+', '', 'g')
    when 'walking' then 'walking'
    when 'running' then 'running'
    when 'cycling' then 'cycling'
    when 'swimming' then 'swimming'
    when 'strength' then 'strength'
    when 'yoga' then 'yoga'
    when 'pilates' then 'pilates'
    when 'pushups' then 'pushups'
    when 'squats' then 'squats'
    when 'situps' then 'situps'
    when 'plank' then 'plank'
    when 'pullups' then 'pullups'
    else null
  end
$$;

-- Preserve lifetime EXP; correct only the derived permanent level under V1.
update public.user_progress
set current_level = public.permanent_level_for_exp(total_exp), updated_at = now();
insert into public.permanent_level_history(user_id, level, total_exp_at_level, source, reached_at)
select p.user_id, p.current_level, public.permanent_xp_threshold(p.current_level), 'migration_baseline', p.updated_at
from public.user_progress p
on conflict (user_id, level) do nothing;

create or replace function public.apply_experience_transaction()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_total bigint;
  v_previous_level integer;
  v_level integer;
  v_season_total bigint;
  v_season_level integer;
  v_level_to_record integer;
begin
  insert into public.user_progress(user_id, total_exp, current_level)
  values (new.user_id, new.exp_amount, 1)
  on conflict (user_id) do update
    set total_exp = public.user_progress.total_exp + excluded.total_exp,
        updated_at = now()
  returning total_exp into v_total;

  v_previous_level := public.permanent_level_for_exp(v_total - new.exp_amount);
  v_level := public.permanent_level_for_exp(v_total);
  update public.user_progress
    set current_level = v_level, updated_at = now()
    where user_id = new.user_id;

  if v_level > v_previous_level then
    for v_level_to_record in (v_previous_level + 1)..v_level loop
      insert into public.permanent_level_history(user_id, level, total_exp_at_level, source, reached_at)
      values (new.user_id, v_level_to_record, public.permanent_xp_threshold(v_level_to_record), 'earned', new.created_at)
      on conflict (user_id, level) do nothing;
    end loop;
  end if;

  if new.season_id is not null then
    insert into public.season_progress(user_id, season_id, season_exp, season_level, season_rank)
    values (new.user_id, new.season_id, new.exp_amount,
      public.season_level_for_exp(new.exp_amount), public.season_rank_for_exp(new.exp_amount))
    on conflict (user_id, season_id) do update
      set season_exp = public.season_progress.season_exp + excluded.season_exp,
          season_level = public.season_level_for_exp(public.season_progress.season_exp + excluded.season_exp),
          season_rank = public.season_rank_for_exp(public.season_progress.season_exp + excluded.season_exp),
          updated_at = now()
    returning season_exp, season_level into v_season_total, v_season_level;
  end if;
  return new;
end;
$$;

drop trigger if exists on_experience_transaction_created on public.experience_transactions;
create trigger on_experience_transaction_created
  after insert on public.experience_transactions
  for each row execute procedure public.apply_experience_transaction();

create or replace function public.reserve_activity_award(
  p_user_id uuid,
  p_request_key uuid,
  p_activity jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing public.activity_award_attempts%rowtype;
  v_activity public.activities%rowtype;
  v_activity_id uuid;
  v_type text := public.canonical_activity_type(p_activity ->> 'activity_type');
  v_source text := coalesce(p_activity ->> 'source', 'manual');
  v_source_key text := nullif(p_activity ->> 'source_key', '');
  v_activity_date timestamptz := coalesce(nullif(p_activity ->> 'activity_date','')::timestamptz, now());
  v_duration numeric(10,2) := coalesce(nullif(p_activity ->> 'duration_minutes','')::numeric, nullif(p_activity ->> 'duration','')::numeric, 0);
  v_distance_km numeric(10,3) := nullif(coalesce(p_activity ->> 'distance_km', p_activity ->> 'distance'), '')::numeric;
  v_distance_meters numeric(12,2) := nullif(p_activity ->> 'distance_meters', '')::numeric;
  v_steps integer := nullif(p_activity ->> 'steps', '')::integer;
  v_active_calories numeric(10,2) := nullif(p_activity ->> 'active_calories', '')::numeric;
  v_calories integer := nullif(p_activity ->> 'calories', '')::integer;
  v_repetitions integer := nullif(p_activity ->> 'repetitions', '')::integer;
  v_hold_seconds numeric(10,2) := nullif(p_activity ->> 'hold_seconds', '')::numeric;
  v_demo boolean := coalesce((p_activity ->> 'demo')::boolean, false);
  v_confirmed boolean := coalesce((p_activity ->> 'screenshot_confirmed')::boolean, false);
  v_timezone text;
  v_local_date date;
  v_metric_type text;
  v_metric_amount numeric(12,3) := 0;
  v_daily_before numeric(12,3) := 0;
  v_candidate boolean := false;
  v_status text;
  v_season_id uuid;
  v_validation_status text;
  v_validation_method text;
begin
  if p_user_id is null or p_request_key is null then raise exception 'User and idempotency key are required'; end if;
  if v_source not in ('manual','screenshot') then raise exception 'Only manual and screenshot activity submissions are enabled in Phase 2'; end if;
  if v_type is null then
    raise exception 'Unsupported activity type';
  end if;
  if v_duration <= 0 or v_duration > 1440 then raise exception 'Activity duration is invalid'; end if;
  if v_source = 'screenshot' and v_confirmed and not v_demo then
    v_validation_status := 'user_confirmed';
    v_validation_method := 'screenshot_user_confirmation';
  elsif v_demo then
    v_validation_status := 'demo';
    v_validation_method := 'demo_extraction';
  elsif v_source = 'screenshot' then
    v_validation_status := 'pending_review';
    v_validation_method := 'screenshot_unconfirmed';
  else
    v_validation_status := 'unverified';
    v_validation_method := 'manual_entry';
  end if;

  select timezone into v_timezone from public.profiles where id = p_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_local_date := (v_activity_date at time zone v_timezone)::date;

  v_metric_type := case lower(v_type)
    when 'running' then 'distanceKm' when 'cycling' then 'distanceKm'
    when 'walking' then 'steps' when 'swimming' then 'distanceMeters'
    when 'strength' then 'durationMinutes' when 'yoga' then 'durationMinutes'
    when 'pilates' then 'durationMinutes' when 'pushups' then 'repetitions'
    when 'squats' then 'repetitions' when 'situps' then 'repetitions'
    when 'pullups' then 'repetitions' when 'plank' then 'holdSeconds'
    else 'unsupported' end;
  v_metric_amount := case v_metric_type
    when 'distanceKm' then coalesce(v_distance_km,0)
    when 'steps' then coalesce(v_steps,0)
    when 'distanceMeters' then coalesce(v_distance_meters,0)
    when 'durationMinutes' then v_duration
    when 'repetitions' then coalesce(v_repetitions,0)
    when 'holdSeconds' then coalesce(v_hold_seconds,0)
    else 0 end;
  v_candidate := v_source = 'screenshot' and v_confirmed and not v_demo
    and v_metric_amount > 0 and v_metric_type <> 'unsupported'
    and lower(v_type) not in ('walking','pushups','squats','situps','plank','pullups');
  v_status := case when v_candidate then 'pending'
    when v_demo or v_source = 'manual' then 'ineligible'
    else 'requires_review' end;

  -- Same request key returns the original result on retries.
  select * into v_existing from public.activity_award_attempts
    where user_id = p_user_id and request_key = p_request_key;
  if found then
    select * into v_activity from public.activities where id = v_existing.activity_id;
    return jsonb_build_object('duplicate', true, 'attempt_id', v_existing.id,
      'activity_id', v_existing.activity_id, 'status', v_existing.status,
      'xp', v_existing.result_xp, 'daily_metric_before', v_existing.daily_metric_before,
      'activity', to_jsonb(v_activity));
  end if;

  if v_source_key is not null then
    select id into v_activity_id from public.activities
      where user_id = p_user_id and source = v_source and source_key = v_source_key;
    if found then
      select * into v_existing from public.activity_award_attempts where activity_id = v_activity_id;
      select * into v_activity from public.activities where id = v_activity_id;
      return jsonb_build_object('duplicate', true, 'activity_id', v_activity_id,
        'status', coalesce(v_existing.status, 'legacy_unreviewed'),
        'xp', coalesce(v_existing.result_xp, 0), 'activity', to_jsonb(v_activity));
    end if;
  end if;

  -- Serialize same-user, same-local-day, same-metric reservations before reading the cap.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_local_date::text || ':' || v_type, 0)
  );
  if v_candidate then
    select coalesce(sum(metric_amount),0) into v_daily_before
      from public.activity_award_attempts
      where user_id = p_user_id and local_date = v_local_date
        and activity_type = v_type and metric_type = v_metric_type
        and counts_toward_cap and status in ('pending','awarded');
  end if;

  select id into v_season_id from public.seasons
    where starts_at <= now() and now() < ends_at
    order by starts_at desc limit 1;

  insert into public.activities(
    user_id, activity_type, duration, duration_minutes, distance, distance_km,
    distance_meters, steps, calories, active_calories, repetitions, hold_seconds,
    activity_date, source, source_key, notes, metadata, validation_status,
    validation_method, request_key
  ) values (
    p_user_id, v_type, greatest(1, ceil(v_duration)::integer), v_duration,
    v_distance_km, v_distance_km, v_distance_meters, v_steps, v_calories,
    v_active_calories, v_repetitions, v_hold_seconds, v_activity_date,
    v_source, v_source_key, left(nullif(p_activity ->> 'notes',''),500),
    jsonb_build_object('demo',v_demo,'screenshot_confirmed',v_confirmed),
    v_validation_status, v_validation_method, p_request_key
  ) on conflict do nothing returning id into v_activity_id;
  if v_activity_id is null then
    select id into v_activity_id from public.activities where user_id=p_user_id and request_key=p_request_key;
    if v_activity_id is null and v_source_key is not null then
      select id into v_activity_id from public.activities where user_id=p_user_id and source=v_source and source_key=v_source_key;
    end if;
    if v_activity_id is null then raise exception 'Activity could not be reserved safely'; end if;
    select * into v_activity from public.activities where id=v_activity_id;
    return jsonb_build_object('duplicate',true,'activity_id',v_activity_id,'status',v_activity.validation_status,'xp',0,'activity',to_jsonb(v_activity));
  end if;
  select * into v_activity from public.activities where id = v_activity_id;
  insert into public.activity_award_attempts(
    user_id, activity_id, request_key, activity_type, metric_type, local_date,
    metric_amount, daily_metric_before, counts_toward_cap, season_id, status,
    result_metadata
  ) values (
    p_user_id, v_activity_id, p_request_key, v_type, v_metric_type, v_local_date,
    v_metric_amount, v_daily_before, v_candidate, v_season_id, v_status,
    case when v_candidate then '{}'::jsonb else jsonb_build_object('reason',
      case when v_demo then 'demo_data' when v_source='manual' then 'manual_unverified'
      when v_metric_type='unsupported' then 'unsupported_legacy_activity'
      when lower(v_type)='walking' then 'daily_steps_require_settlement'
      when lower(v_type) in ('pushups','squats','situps','plank','pullups') then 'camera_validation_not_enabled'
      else 'confirmation_required' end) end
  ) returning * into v_existing;

  return jsonb_build_object('duplicate',false,'attempt_id',v_existing.id,
    'activity_id',v_activity_id,'status',v_existing.status,'xp',0,
    'daily_metric_before',v_daily_before,'activity',to_jsonb(v_activity));
end;
$$;

create or replace function public.finalize_activity_award(
  p_user_id uuid,
  p_request_key uuid,
  p_result_status text,
  p_exp_amount integer,
  p_validation_status text,
  p_rule_version text,
  p_result_metadata jsonb default '{}'::jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.activity_award_attempts%rowtype;
  v_activity public.activities%rowtype;
  v_tx public.experience_transactions%rowtype;
  v_total bigint;
  v_level integer;
begin
  if p_result_status not in ('eligible','requires-review','ineligible') then raise exception 'Invalid award result'; end if;
  if p_validation_status not in ('user_confirmed','provider_verified','pose_validated','pending_review','rejected','demo','unverified') then
    raise exception 'Invalid validation status';
  end if;
  if p_exp_amount < 0 or (p_result_status <> 'eligible' and p_exp_amount <> 0) then
    raise exception 'EXP result is inconsistent with validation';
  end if;
  if p_result_status = 'eligible' and (p_exp_amount <= 0 or p_rule_version is null) then
    raise exception 'Eligible awards require positive EXP and a rule version';
  end if;

  select * into v_attempt from public.activity_award_attempts
    where user_id=p_user_id and request_key=p_request_key for update;
  if not found then raise exception 'No activity award reservation exists'; end if;
  if v_attempt.status <> 'pending' then
    select * into v_activity from public.activities where id=v_attempt.activity_id;
    select * into v_tx from public.experience_transactions where id=v_attempt.transaction_id;
    select total_exp,current_level into v_total,v_level from public.user_progress where user_id=p_user_id;
    return jsonb_build_object('duplicate',true,'activity_id',v_attempt.activity_id,
      'transaction_id',v_attempt.transaction_id,'status',v_attempt.status,
      'xp',v_attempt.result_xp,'total_exp',coalesce(v_total,0),'level',coalesce(v_level,1));
  end if;
  if p_result_status='eligible' and not exists(
    select 1 from public.exp_rule_versions where version=p_rule_version
  ) then raise exception 'Unknown EXP rule version'; end if;

  select * into v_activity from public.activities where id=v_attempt.activity_id for update;
  if p_exp_amount > 0 then
    insert into public.experience_transactions(
      user_id, activity_id, exp_amount, transaction_type, idempotency_key,
      metadata, rule_version, season_id
    ) values (
      p_user_id, v_activity.id, p_exp_amount, 'activity', 'activity:'||v_activity.id::text,
      coalesce(p_result_metadata,'{}'::jsonb), p_rule_version, v_attempt.season_id
    ) returning * into v_tx;
  end if;
  update public.activities set validation_status=p_validation_status,
    validation_method=coalesce(p_result_metadata->>'validation_method',validation_method),
    validation_confidence=nullif(p_result_metadata->>'confidence','')::numeric,
    validation_deviation_percent=nullif(p_result_metadata->>'deviation_percent','')::numeric,
    exp_rule_version=case when p_exp_amount > 0 then p_rule_version else exp_rule_version end
    where id=v_attempt.activity_id;
  update public.activity_award_attempts set
    status=case when p_exp_amount > 0 then 'awarded'
      when p_result_status='requires-review' then 'requires_review' else 'ineligible' end,
    result_xp=p_exp_amount,
    transaction_id=case when p_exp_amount > 0 then v_tx.id else null end,
    result_metadata=coalesce(p_result_metadata,'{}'::jsonb),
    finalized_at=now()
    where id=v_attempt.id;
  select total_exp,current_level into v_total,v_level from public.user_progress where user_id=p_user_id;
  return jsonb_build_object('duplicate',false,'activity_id',v_attempt.activity_id,
    'transaction_id',v_tx.id,'status',case when p_exp_amount > 0 then 'awarded' else p_result_status end,
    'xp',p_exp_amount,'total_exp',coalesce(v_total,0),'level',coalesce(v_level,1));
end;
$$;

create or replace function public.archive_ended_seasons()
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  insert into public.season_history(user_id,season_id,season_key,season_name,starts_at,ends_at,season_exp,season_level,season_rank)
  select sp.user_id,s.id,s.season_key,s.name,s.starts_at,s.ends_at,sp.season_exp,sp.season_level,sp.season_rank
    from public.season_progress sp join public.seasons s on s.id=sp.season_id
    where s.ends_at <= now()
  on conflict (user_id,season_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Direct client mutation of EXP, activity rows and progression remains denied.
revoke all on public.exp_rule_versions, public.seasons, public.permanent_level_history,
  public.season_progress, public.season_history, public.daily_step_settlements,
  public.activity_duplicate_checks, public.activity_award_attempts
  from public, anon, authenticated;
grant select on public.exp_rule_versions to authenticated;
grant select on public.seasons to authenticated;
grant select on public.permanent_level_history, public.season_progress,
  public.season_history, public.daily_step_settlements, public.activity_duplicate_checks,
  public.activity_award_attempts to authenticated;
revoke insert, update, delete on public.experience_transactions, public.user_progress,
  public.activities, public.season_progress, public.season_history,
  public.daily_step_settlements, public.activity_award_attempts from anon, authenticated;
grant select on public.activities, public.experience_transactions, public.user_progress to authenticated;
grant select on public.profiles to authenticated;
grant update(username, avatar_configuration, timezone) on public.profiles to authenticated;

alter table public.exp_rule_versions enable row level security;
alter table public.seasons enable row level security;
alter table public.permanent_level_history enable row level security;
alter table public.season_progress enable row level security;
alter table public.season_history enable row level security;
alter table public.daily_step_settlements enable row level security;
alter table public.activity_duplicate_checks enable row level security;
alter table public.activity_award_attempts enable row level security;

create policy "EXP rule versions are readable by signed-in users" on public.exp_rule_versions
  for select to authenticated using (true);
create policy "Season schedule is readable by signed-in users" on public.seasons
  for select to authenticated using (true);
create policy "Permanent level history is private to its owner" on public.permanent_level_history
  for select to authenticated using (user_id=(select auth.uid()));
create policy "Season progression is private to its owner" on public.season_progress
  for select to authenticated using (user_id=(select auth.uid()));
create policy "Season history is private to its owner" on public.season_history
  for select to authenticated using (user_id=(select auth.uid()));
create policy "Step settlements are private to their owner" on public.daily_step_settlements
  for select to authenticated using (user_id=(select auth.uid()));
create policy "Duplicate checks are private to their owner" on public.activity_duplicate_checks
  for select to authenticated using (user_id=(select auth.uid()));
create policy "Award attempts are private to their owner" on public.activity_award_attempts
  for select to authenticated using (user_id=(select auth.uid()));

-- Remove the old, client-callable minute-based award path. Keep the functions for rollback/audit,
-- but only the new authenticated Edge Function's service role can reserve/finalize awards.
revoke all on function public.record_activity(jsonb) from public, anon, authenticated;
revoke all on function public.calculate_activity_exp(text, integer) from public, anon, authenticated;
revoke all on function public.apply_experience_transaction() from public, anon, authenticated;
revoke all on function public.create_profile_for_user() from public, anon, authenticated;
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
revoke all on function public.permanent_level_for_exp(bigint) from public, anon, authenticated;
revoke all on function public.permanent_xp_threshold(integer) from public, anon, authenticated;
revoke all on function public.season_level_for_exp(bigint) from public, anon, authenticated;
revoke all on function public.season_rank_for_exp(bigint) from public, anon, authenticated;
revoke all on function public.canonical_activity_type(text) from public, anon, authenticated;
revoke all on function public.prevent_overlapping_seasons() from public, anon, authenticated;
revoke all on function public.reserve_activity_award(uuid,uuid,jsonb) from public, anon, authenticated;
revoke all on function public.finalize_activity_award(uuid,uuid,text,integer,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.archive_ended_seasons() from public, anon, authenticated;
grant execute on function public.reserve_activity_award(uuid,uuid,jsonb) to service_role;
grant execute on function public.finalize_activity_award(uuid,uuid,text,integer,text,text,jsonb) to service_role;
grant execute on function public.archive_ended_seasons() to service_role;

commit;

