-- Serialize screenshot submissions and reject workouts that closely match an
-- existing activity from any source. No activity or EXP rows are modified.
create or replace function public.reserve_screenshot_activity_award(
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
  v_date timestamptz := nullif(p_activity ->> 'activity_date','')::timestamptz;
  v_duration numeric := nullif(p_activity ->> 'duration_minutes','')::numeric;
  v_distance numeric := nullif(p_activity ->> 'distance_km','')::numeric;
  v_timezone text;
  v_local_date date;
  v_activity public.activities%rowtype;
  v_attempt public.activity_award_attempts%rowtype;
begin
  if p_user_id is null or p_request_key is null then
    raise exception 'User and idempotency key are required';
  end if;
  if coalesce(p_activity ->> 'source','manual') <> 'screenshot'
    or coalesce((p_activity ->> 'screenshot_confirmed')::boolean,false) is not true
  then
    return public.reserve_activity_award(p_user_id,p_request_key,p_activity);
  end if;
  if v_type is null or v_date is null or v_duration is null or v_duration <= 0 then
    raise exception 'Activity data is invalid';
  end if;

  select timezone into v_timezone from public.profiles where id = p_user_id;
  if v_timezone is null or not exists(select 1 from pg_catalog.pg_timezone_names where name = v_timezone) then
    v_timezone := 'UTC';
  end if;
  v_local_date := (v_date at time zone v_timezone)::date;

  -- The same lock used by the primary award RPC closes the race between two
  -- different request IDs representing the same workout.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_user_id::text || ':' || v_local_date::text || ':' || v_type,0)
  );

  if v_distance is not null then
    select * into v_activity from public.activities a
    where a.user_id = p_user_id
      and public.canonical_activity_type(a.activity_type) = v_type
      and a.activity_date between v_date - interval '3 minutes' and v_date + interval '3 minutes'
      and abs(a.duration_minutes - v_duration) <= 2
      and a.distance_km is not null
      and abs(a.distance_km - v_distance) <= 0.05
      and a.metadata ->> 'demo' is distinct from 'true'
    order by abs(extract(epoch from (a.activity_date - v_date)))
    limit 1;
    if found then
      select * into v_attempt from public.activity_award_attempts where activity_id = v_activity.id;
      return jsonb_build_object(
        'duplicate',true,
        'possible_match',true,
        'activity_id',v_activity.id,
        'attempt_id',v_attempt.id,
        'status',coalesce(v_attempt.status,v_activity.validation_status),
        'xp',coalesce(v_attempt.result_xp,0),
        'activity',to_jsonb(v_activity)
      );
    end if;
  end if;

  return public.reserve_activity_award(p_user_id,p_request_key,p_activity);
end;
$$;

revoke all on function public.reserve_screenshot_activity_award(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.reserve_screenshot_activity_award(uuid,uuid,jsonb) to service_role;

