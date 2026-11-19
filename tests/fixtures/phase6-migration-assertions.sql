-- Assertions after applying phase6-baseline.sql and the Phase 6 migration.
do $$
declare
  before_count integer;
  call_one jsonb;
  call_two jsonb;
  fn regprocedure := 'public.reserve_camera_exercise_award(uuid,uuid,jsonb)'::regprocedure;
begin
  select count(*) into before_count from public.profiles;
  if before_count <> 1
    or (select count(*) from public.activities) <> 1
    or (select count(*) from public.experience_transactions) <> 1
    or (select sum(exp_amount) from public.experience_transactions) <> 720 then
    raise exception 'The migration changed seeded production-like user data or EXP';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.activities'::regclass
      and conname='activities_source_check'
      and pg_get_constraintdef(oid) like '%camera%'
      and pg_get_constraintdef(oid) like '%screenshot%'
  ) then raise exception 'The camera source check did not preserve existing sources'; end if;

  if (select count(*) from pg_policies where schemaname='public'
      and tablename in ('profiles','activities','activity_award_attempts')) <> 4 then
    raise exception 'Existing owner RLS policies were not preserved';
  end if;
  if not exists (
    select 1 from pg_class where oid='public.activities'::regclass and relrowsecurity
  ) then raise exception 'Activity RLS is not enabled'; end if;
  if has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('authenticated', fn, 'EXECUTE')
     or not has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception 'Camera reservation function execution grants are unsafe';
  end if;

  call_one := public.reserve_camera_exercise_award(
    '11111111-1111-4111-8111-111111111111',
    '66666666-6666-4666-8666-666666666666',
    jsonb_build_object(
      'activity_type','pushups','source','camera',
      'source_key','66666666-6666-4666-8666-666666666666',
      'activity_date',now()::text,
      'exercise_validation',jsonb_build_object(
        'reportedReps',10,'detectedReps',10,'confidence',0.95,
        'recordingDurationSeconds',30,'usableFrames',20,'usableRatio',0.9,
        'modelVersion','pose_landmarker_lite_float16_v1',
        'validationVersion','mylvl-pose-v1'
      )
    )
  );
  call_two := public.reserve_camera_exercise_award(
    '11111111-1111-4111-8111-111111111111',
    '66666666-6666-4666-8666-666666666666',
    jsonb_build_object(
      'activity_type','pushups','source','camera',
      'source_key','66666666-6666-4666-8666-666666666666',
      'activity_date',now()::text,
      'exercise_validation',jsonb_build_object(
        'reportedReps',10,'detectedReps',10,'confidence',0.95,
        'recordingDurationSeconds',30,'usableFrames',20,'usableRatio',0.9,
        'modelVersion','pose_landmarker_lite_float16_v1',
        'validationVersion','mylvl-pose-v1'
      )
    )
  );
  if (call_one->>'duplicate')::boolean is true or (call_two->>'duplicate')::boolean is not true then
    raise exception 'Repeated camera request was not idempotent';
  end if;
  if (select count(*) from public.activities) <> 2
     or (select count(*) from public.activity_award_attempts) <> 2
     or (select sum(exp_amount) from public.experience_transactions) <> 720 then
    raise exception 'Camera reservation duplicated rows or changed EXP';
  end if;
end;
$$;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','99999999-9999-4999-8999-999999999999',true);
do $$
begin
  if exists(select 1 from public.activities where id='22222222-2222-4222-8222-222222222222') then
    raise exception 'RLS exposed another user activity';
  end if;
end;
$$;
rollback;
