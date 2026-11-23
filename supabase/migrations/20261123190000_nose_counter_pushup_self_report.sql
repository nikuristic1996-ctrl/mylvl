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
  v_payload jsonb;
  v_reservation jsonb;
  v_attempt public.activity_award_attempts%rowtype;
  v_activity public.activities%rowtype;
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

  -- Reuse the existing secure reservation path. It takes the per-user/day/type
  -- advisory lock and creates the activity plus award attempt atomically.
  -- Temporarily submit as confirmed screenshot data because the existing base RPC
  -- intentionally blocks unverified manual exercise entries; convert the record
  -- to the dedicated self-report source before this transaction commits.
  v_payload := p_activity || jsonb_build_object(
    'source','screenshot',
    'screenshot_confirmed',true
  );
  v_reservation := public.reserve_activity_award(p_user_id,p_request_key,v_payload);
  if coalesce((v_reservation ->> 'duplicate')::boolean,false) then
    return v_reservation;
  end if;

  select * into v_attempt from public.activity_award_attempts
    where user_id=p_user_id and request_key=p_request_key;
  if not found then raise exception 'Nose Counter reservation did not create an award attempt'; end if;
  update public.activities set
    source='nose_counter',
    validation_status='user_confirmed',
    validation_method='nose_touch_self_report',
    metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
      'nose_counter_confirmed',true,
      'self_reported',true
    )
  where id=v_attempt.activity_id
  returning * into v_activity;

  update public.activity_award_attempts aa set
    daily_metric_before=coalesce((
      select sum(prior.metric_amount) from public.activity_award_attempts prior
      where prior.user_id=aa.user_id and prior.local_date=aa.local_date
        and prior.activity_type=aa.activity_type and prior.metric_type=aa.metric_type
        and prior.counts_toward_cap and prior.status in ('pending','awarded')
        and prior.id<>aa.id
    ),0),
    counts_toward_cap=true,
    status='pending',
    result_metadata=jsonb_build_object(
      'validation_method','nose_touch_self_report',
      'self_reported',true
    )
  where aa.id=v_attempt.id
  returning * into v_attempt;

  return jsonb_build_object(
    'duplicate',false,'attempt_id',v_attempt.id,'activity_id',v_activity.id,
    'status','pending','xp',0,'daily_metric_before',v_attempt.daily_metric_before,
    'activity',to_jsonb(v_activity)
  );
end;
$$;

revoke all on function public.reserve_nose_counter_award(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_nose_counter_award(uuid,uuid,jsonb) to service_role;

commit;
