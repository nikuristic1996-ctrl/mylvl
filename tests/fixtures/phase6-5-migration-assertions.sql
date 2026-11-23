-- Cloud CI assertions after the Phase 6.5 camera workout RPC migration.
-- This runs only against the disposable PostgreSQL service started by GitHub Actions.
do $$
declare
  before_activity_count integer;
  before_attempt_count integer;
  before_xp integer;
  situp_one jsonb;
  situp_duplicate jsonb;
  plank_one jsonb;
  plank_duplicate jsonb;
  fn regprocedure := 'public.reserve_camera_exercise_award(uuid,uuid,jsonb)'::regprocedure;
  rejected boolean := false;
begin
  select count(*) into before_activity_count from public.activities;
  select count(*) into before_attempt_count from public.activity_award_attempts;
  select coalesce(sum(exp_amount),0) into before_xp from public.experience_transactions;

  if has_function_privilege('anon', fn, 'EXECUTE')
     or has_function_privilege('authenticated', fn, 'EXECUTE')
     or not has_function_privilege('service_role', fn, 'EXECUTE') then
    raise exception 'Camera reservation function execution grants are unsafe';
  end if;

  situp_one := public.reserve_camera_exercise_award(
    '11111111-1111-4111-8111-111111111111',
    '66666666-6666-4666-8666-666666666666',
    jsonb_build_object(
      'activity_type','situps','source','camera','source_key','66666666-6666-4666-8666-666666666666',
      'activity_date',now()::text,
      'exercise_validation',jsonb_build_object(
        'exerciseType','situps','metricType','repetitions','reportedReps',20,'detectedReps',19,
        'confidence',0.95,'recordingDurationSeconds',30,'usableFrames',20,'usableRatio',0.9,
        'modelVersion','pose_landmarker_lite_float16_v1','validationVersion','mylvl-pose-v1'
      )
    )
  );
  situp_duplicate := public.reserve_camera_exercise_award(
    '11111111-1111-4111-8111-111111111111',
    '66666666-6666-4666-8666-666666666666',
    jsonb_build_object(
      'activity_type','situps','source','camera','source_key','66666666-6666-4666-8666-666666666666',
      'activity_date',now()::text,
      'exercise_validation',jsonb_build_object(
        'exerciseType','situps','metricType','repetitions','reportedReps',20,'detectedReps',19,
        'confidence',0.95,'recordingDurationSeconds',30,'usableFrames',20,'usableRatio',0.9,
        'modelVersion','pose_landmarker_lite_float16_v1','validationVersion','mylvl-pose-v1'
      )
    )
  );
  if (situp_one->>'duplicate')::boolean is true or (situp_duplicate->>'duplicate')::boolean is not true then
    raise exception 'Sit-up camera reservation was not idempotent';
  end if;
  if (select repetitions from public.activities where id=(situp_one->>'activity_id')::uuid) <> 19
    or (select metric_amount from public.activity_award_attempts where activity_id=(situp_one->>'activity_id')::uuid) <> 19
    or (select metric_type from public.activity_award_attempts where activity_id=(situp_one->>'activity_id')::uuid) <> 'repetitions' then
    raise exception 'Sit-up reservation did not use detected repetitions';
  end if;

  plank_one := public.reserve_camera_exercise_award(
    '11111111-1111-4111-8111-111111111111',
    '77777777-7777-4777-8777-777777777777',
    jsonb_build_object(
      'activity_type','plank','source','camera','source_key','77777777-7777-4777-8777-777777777777',
      'activity_date',now()::text,
      'exercise_validation',jsonb_build_object(
        'exerciseType','plank','metricType','hold_seconds','reportedHoldSeconds',30,'detectedHoldSeconds',29,
        'confidence',0.95,'recordingDurationSeconds',35,'usableFrames',30,'usableRatio',0.9,
        'modelVersion','pose_landmarker_lite_float16_v1','validationVersion','mylvl-pose-v1'
      )
    )
  );
  plank_duplicate := public.reserve_camera_exercise_award(
    '11111111-1111-4111-8111-111111111111',
    '77777777-7777-4777-8777-777777777777',
    jsonb_build_object(
      'activity_type','plank','source','camera','source_key','77777777-7777-4777-8777-777777777777',
      'activity_date',now()::text,
      'exercise_validation',jsonb_build_object(
        'exerciseType','plank','metricType','hold_seconds','reportedHoldSeconds',30,'detectedHoldSeconds',29,
        'confidence',0.95,'recordingDurationSeconds',35,'usableFrames',30,'usableRatio',0.9,
        'modelVersion','pose_landmarker_lite_float16_v1','validationVersion','mylvl-pose-v1'
      )
    )
  );
  if (plank_one->>'duplicate')::boolean is true or (plank_duplicate->>'duplicate')::boolean is not true then
    raise exception 'Plank camera reservation was not idempotent';
  end if;
  if (select hold_seconds from public.activities where id=(plank_one->>'activity_id')::uuid) <> 29
    or (select metric_amount from public.activity_award_attempts where activity_id=(plank_one->>'activity_id')::uuid) <> 29
    or (select metric_type from public.activity_award_attempts where activity_id=(plank_one->>'activity_id')::uuid) <> 'holdSeconds' then
    raise exception 'Plank reservation did not persist validated seconds';
  end if;

  begin
    perform public.reserve_camera_exercise_award(
      '11111111-1111-4111-8111-111111111111',
      '88888888-8888-4888-8888-888888888888',
      jsonb_build_object(
        'activity_type','situps','source','camera','source_key','88888888-8888-4888-8888-888888888888',
        'activity_date',now()::text,
        'exercise_validation',jsonb_build_object(
          'exerciseType','situps','reportedReps',20,'detectedReps',15,'confidence',0.95,
          'recordingDurationSeconds',30,'usableFrames',20,'usableRatio',0.9,
          'modelVersion','pose_landmarker_lite_float16_v1','validationVersion','mylvl-pose-v1'
        )
      )
    );
  exception when raise_exception then
    if sqlerrm like 'Camera exercise validation did not meet%' then rejected := true; else raise; end if;
  end;
  if not rejected then raise exception 'Camera report >10%% difference was accepted'; end if;

  if (select count(*) from public.activities) <> before_activity_count + 2
    or (select count(*) from public.activity_award_attempts) <> before_attempt_count + 2
    or (select coalesce(sum(exp_amount),0) from public.experience_transactions) <> before_xp then
    raise exception 'Reservation duplicated data or awarded EXP before secure finalization';
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
