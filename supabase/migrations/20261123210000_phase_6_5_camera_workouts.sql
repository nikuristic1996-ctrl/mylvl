-- Phase 6.5: safely reserve camera awards for push-ups, squats, sit-ups and planks.
-- This replaces one RPC only. It does not alter existing rows, EXP, tables, or RLS policies.
begin;

create or replace function public.reserve_camera_exercise_award(
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
  v_session uuid := nullif(p_activity ->> 'source_key','')::uuid;
  v_validation jsonb := p_activity -> 'exercise_validation';
  v_reported integer := nullif(v_validation ->> 'reportedReps','')::integer;
  v_detected integer := nullif(v_validation ->> 'detectedReps','')::integer;
  v_reported_hold numeric := nullif(v_validation ->> 'reportedHoldSeconds','')::numeric;
  v_detected_hold numeric := nullif(v_validation ->> 'detectedHoldSeconds','')::numeric;
  v_reported_amount numeric;
  v_detected_amount numeric;
  v_confidence numeric := nullif(v_validation ->> 'confidence','')::numeric;
  v_duration numeric := nullif(v_validation ->> 'recordingDurationSeconds','')::numeric;
  v_usable_frames integer := nullif(v_validation ->> 'usableFrames','')::integer;
  v_usable_ratio numeric := nullif(v_validation ->> 'usableRatio','')::numeric;
  v_date timestamptz := nullif(p_activity ->> 'activity_date','')::timestamptz;
  v_timezone text;
  v_local_date date;
  v_metric_type text;
  v_metric_amount numeric(12,3);
  v_deviation numeric;
  v_daily_before numeric(12,3) := 0;
  v_season_id uuid;
  v_activity_id uuid;
  v_activity public.activities%rowtype;
  v_attempt public.activity_award_attempts%rowtype;
begin
  if p_user_id is null or p_request_key is null or v_session is null or v_session <> p_request_key then
    raise exception 'A matching camera session and idempotency key are required';
  end if;
  if coalesce(p_activity ->> 'source','') <> 'camera'
    or v_type not in ('pushups','squats','situps','plank')
    or coalesce(v_validation ->> 'exerciseType',v_type) <> v_type
    or coalesce(v_validation ->> 'metricType',case when v_type='plank' then 'hold_seconds' else 'repetitions' end)
      <> case when v_type='plank' then 'hold_seconds' else 'repetitions' end then
    raise exception 'Camera awards support only matching push-ups, squats, sit-ups or plank sessions';
  end if;

  if v_type = 'plank' then
    v_metric_type := 'holdSeconds';
    v_reported_amount := v_reported_hold;
    v_detected_amount := v_detected_hold;
    if v_reported_hold is null or v_detected_hold is null
      or v_reported_hold < 10 or v_reported_hold > 90
      or v_detected_hold < 10 or v_detected_hold > 90 then
      raise exception 'Plank duration must be between 10 and 90 validated seconds';
    end if;
  else
    v_metric_type := 'repetitions';
    v_reported_amount := v_reported;
    v_detected_amount := v_detected;
    if v_reported is null or v_detected is null
      or v_reported not between 1 and 500 or v_detected not between 1 and 500 then
      raise exception 'Reported and detected repetitions must be between 1 and 500';
    end if;
  end if;

  if v_usable_frames is null or v_usable_frames < 12
    or v_confidence is null or v_confidence < 0.60 or v_confidence > 1
    or v_usable_ratio is null or v_usable_ratio < 0.65 or v_usable_ratio > 1
    or v_duration is null or v_duration < 2 or v_duration > 90
    or abs(v_reported_amount - v_detected_amount)::numeric / greatest(1,v_reported_amount,v_detected_amount) > 0.10 then
    raise exception 'Camera exercise validation did not meet the required limits (maximum estimate difference is 10 percent)';
  end if;
  if coalesce(v_validation ->> 'modelVersion','') <> 'pose_landmarker_lite_float16_v1'
    or coalesce(v_validation ->> 'validationVersion','') <> 'mylvl-pose-v1' then
    raise exception 'Camera model and validation versions are required';
  end if;
  if v_date is null or abs(extract(epoch from (now() - v_date))) > 900 then
    raise exception 'Camera exercise session timestamp is not recent';
  end if;
  v_metric_amount := v_detected_amount;
  v_deviation := abs(v_reported_amount-v_detected_amount) / greatest(1,v_reported_amount,v_detected_amount) * 100;
  v_date := coalesce(v_date, now());

  -- Idempotency is enforced by both request key and unique session source key.
  select * into v_attempt from public.activity_award_attempts
    where user_id = p_user_id and request_key = p_request_key;
  if found then
    select * into v_activity from public.activities where id = v_attempt.activity_id;
    return jsonb_build_object('duplicate',true,'attempt_id',v_attempt.id,'activity_id',v_attempt.activity_id,
      'status',v_attempt.status,'xp',v_attempt.result_xp,'daily_metric_before',v_attempt.daily_metric_before,'activity',to_jsonb(v_activity));
  end if;
  select id into v_activity_id from public.activities where user_id=p_user_id and source='camera' and source_key=v_session::text;
  if found then
    select * into v_attempt from public.activity_award_attempts where activity_id=v_activity_id;
    select * into v_activity from public.activities where id=v_activity_id;
    return jsonb_build_object('duplicate',true,'attempt_id',v_attempt.id,'activity_id',v_activity_id,
      'status',coalesce(v_attempt.status,v_activity.validation_status),'xp',coalesce(v_attempt.result_xp,0),'activity',to_jsonb(v_activity));
  end if;

  select timezone into v_timezone from public.profiles where id=p_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name=v_timezone) then v_timezone := 'UTC'; end if;
  v_local_date := (v_date at time zone v_timezone)::date;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::text || ':' || v_local_date::text || ':' || v_type,0));
  select coalesce(sum(metric_amount),0) into v_daily_before from public.activity_award_attempts
    where user_id=p_user_id and local_date=v_local_date and activity_type=v_type and metric_type=v_metric_type
      and counts_toward_cap and status in ('pending','awarded');
  select id into v_season_id from public.seasons where starts_at <= now() and now() < ends_at order by starts_at desc limit 1;

  insert into public.activities(
    user_id,activity_type,duration,duration_minutes,activity_date,source,source_key,notes,metadata,
    validation_status,validation_method,validation_confidence,validation_deviation_percent,request_key,repetitions,hold_seconds
  ) values (
    p_user_id,v_type,greatest(1,ceil(v_duration / 60)::integer),round(v_duration / 60,2),v_date,'camera',v_session::text,
    left(nullif(p_activity ->> 'notes',''),500),
    jsonb_build_object('demo',false,'exercise_validation',v_validation),
    'pose_validated','local_pose_landmarks',v_confidence,round(v_deviation,3),p_request_key,
    case when v_metric_type='repetitions' then v_detected else null end,
    case when v_metric_type='holdSeconds' then v_detected_amount else null end
  ) on conflict do nothing returning id into v_activity_id;
  if v_activity_id is null then
    select * into v_activity from public.activities where user_id=p_user_id and (request_key=p_request_key or (source='camera' and source_key=v_session::text));
    select * into v_attempt from public.activity_award_attempts where activity_id=v_activity.id;
    return jsonb_build_object('duplicate',true,'attempt_id',v_attempt.id,'activity_id',v_activity.id,
      'status',coalesce(v_attempt.status,v_activity.validation_status),'xp',coalesce(v_attempt.result_xp,0),'activity',to_jsonb(v_activity));
  end if;
  select * into v_activity from public.activities where id=v_activity_id;
  insert into public.activity_award_attempts(
    user_id,activity_id,request_key,activity_type,metric_type,local_date,metric_amount,daily_metric_before,
    counts_toward_cap,season_id,status,result_metadata
  ) values (
    p_user_id,v_activity_id,p_request_key,v_type,v_metric_type,v_local_date,v_metric_amount,v_daily_before,
    true,v_season_id,'pending',jsonb_build_object('validation_method','local_pose_landmarks','metric_type',v_metric_type)
  ) returning * into v_attempt;
  return jsonb_build_object('duplicate',false,'attempt_id',v_attempt.id,'activity_id',v_activity_id,'status','pending',
    'xp',0,'daily_metric_before',v_daily_before,'activity',to_jsonb(v_activity));
end;
$$;

revoke all on function public.reserve_camera_exercise_award(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.reserve_camera_exercise_award(uuid,uuid,jsonb) to service_role;

commit;
