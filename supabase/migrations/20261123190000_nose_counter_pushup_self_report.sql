-- Add a self-reported, camera-free push-up path without changing rates or existing rows.
begin;

alter table public.activities
  drop constraint if exists activities_source_check;
alter table public.activities
  add constraint activities_source_check check (source in (
    'manual','screenshot','apple_health','health_connect','garmin','strava','camera','nose_counter'
  ));

create or replace function public.reserve_nose_counter_award(
  p_user_id uuid,
  p_request_key uuid,
  p_activity jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_type text := public.canonical_activity_type(p_activity ->> 'activity_type');
  v_source_key text := nullif(p_activity ->> 'source_key','');
  v_repetitions integer := nullif(p_activity ->> 'repetitions','')::integer;
  v_duration numeric := nullif(p_activity ->> 'duration_minutes','')::numeric;
  v_date timestamptz := nullif(p_activity ->> 'activity_date','')::timestamptz;
  v_timezone text;
  v_local_date date;
  v_daily_before numeric(12,3) := 0;
  v_season_id uuid;
  v_activity_id uuid;
  v_activity public.activities%rowtype;
  v_attempt public.activity_award_attempts%rowtype;
begin
  if p_user_id is null or p_request_key is null then
    raise exception 'User and idempotency key are required';
  end if;
  if coalesce(p_activity ->> 'source','') <> 'nose_counter'
    or coalesce(p_activity ->> 'nose_counter_confirmed','false') <> 'true'
    or v_type <> 'pushups' then
    raise exception 'Nose Counter only accepts explicitly confirmed push-up sets';
  end if;
  if v_repetitions is null or v_repetitions not between 1 and 500 then
    raise exception 'Push-up count must be between 1 and 500';
  end if;
  if v_duration is null or v_duration < 1 or v_duration > 180 then
    raise exception 'Session duration must be between 1 and 180 minutes';
  end if;
  if v_date is null or abs(extract(epoch from (now() - v_date))) > 10800 then
    raise exception 'Nose Counter session time must be within the last three hours';
  end if;
  if v_source_key is null or v_source_key <> p_request_key::text then
    raise exception 'Nose Counter source and idempotency keys must match';
  end if;

  select * into v_attempt from public.activity_award_attempts
    where user_id=p_user_id and request_key=p_request_key;
  if found then
    select * into v_activity from public.activities where id=v_attempt.activity_id;
    return jsonb_build_object('duplicate',true,'attempt_id',v_attempt.id,
      'activity_id',v_attempt.activity_id,'status',v_attempt.status,
      'xp',v_attempt.result_xp,'daily_metric_before',v_attempt.daily_metric_before,
      'activity',to_jsonb(v_activity));
  end if;

  select timezone into v_timezone from public.profiles where id=p_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_local_date := (v_date at time zone v_timezone)::date;

  -- Same-user same-day push-up sessions serialize before source-key checks and cap aggregation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_local_date::text || ':pushups',0)
  );
  select id into v_activity_id from public.activities
    where user_id=p_user_id and source='nose_counter' and source_key=v_source_key;
  if found then
    select * into v_activity from public.activities where id=v_activity_id;
    select * into v_attempt from public.activity_award_attempts where activity_id=v_activity_id;
    return jsonb_build_object('duplicate',true,'attempt_id',v_attempt.id,
      'activity_id',v_activity_id,'status',coalesce(v_attempt.status,v_activity.validation_status),
      'xp',coalesce(v_attempt.result_xp,0),'activity',to_jsonb(v_activity));
  end if;

  select coalesce(sum(metric_amount),0) into v_daily_before
    from public.activity_award_attempts
    where user_id=p_user_id and local_date=v_local_date and activity_type=v_type
      and metric_type='repetitions' and counts_toward_cap and status in ('pending','awarded');
  select id into v_season_id from public.seasons
    where starts_at <= now() and now() < ends_at order by starts_at desc limit 1;

  insert into public.activities(
    user_id,activity_type,duration,duration_minutes,activity_date,source,source_key,
    notes,metadata,validation_status,validation_method,request_key,repetitions
  ) values (
    p_user_id,v_type,greatest(1,ceil(v_duration)::integer),round(v_duration,2),v_date,
    'nose_counter',v_source_key,left(nullif(p_activity ->> 'notes',''),500),
    jsonb_build_object('nose_counter_confirmed',true,'self_reported',true),
    'user_confirmed','nose_touch_self_report',p_request_key,v_repetitions
  ) on conflict do nothing returning id into v_activity_id;

  if v_activity_id is null then
    select * into v_activity from public.activities
      where user_id=p_user_id and (request_key=p_request_key
        or (source='nose_counter' and source_key=v_source_key));
    if not found then raise exception 'Nose Counter activity could not be reserved safely'; end if;
    select * into v_attempt from public.activity_award_attempts where activity_id=v_activity.id;
    return jsonb_build_object('duplicate',true,'attempt_id',v_attempt.id,
      'activity_id',v_activity.id,'status',coalesce(v_attempt.status,v_activity.validation_status),
      'xp',coalesce(v_attempt.result_xp,0),'activity',to_jsonb(v_activity));
  end if;

  select * into v_activity from public.activities where id=v_activity_id;
  insert into public.activity_award_attempts(
    user_id,activity_id,request_key,activity_type,metric_type,local_date,
    metric_amount,daily_metric_before,counts_toward_cap,season_id,status,result_metadata
  ) values (
    p_user_id,v_activity_id,p_request_key,v_type,'repetitions',v_local_date,
    v_repetitions,v_daily_before,true,v_season_id,'pending',
    jsonb_build_object('validation_method','nose_touch_self_report','self_reported',true)
  ) returning * into v_attempt;

  return jsonb_build_object(
    'duplicate',false,'attempt_id',v_attempt.id,'activity_id',v_activity_id,
    'status','pending','xp',0,'daily_metric_before',v_daily_before,
    'activity',to_jsonb(v_activity)
  );
end;
$$;

revoke all on function public.reserve_nose_counter_award(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_nose_counter_award(uuid,uuid,jsonb) to service_role;

commit;
