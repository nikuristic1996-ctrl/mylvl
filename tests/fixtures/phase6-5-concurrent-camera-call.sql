\set ON_ERROR_STOP on
begin;
select public.reserve_camera_exercise_award(
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  jsonb_build_object(
    'activity_type','pushups','source','camera','source_key','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'activity_date',now()::text,
    'exercise_validation',jsonb_build_object(
      'exerciseType','pushups','metricType','repetitions','reportedReps',10,'detectedReps',10,
      'confidence',0.95,'recordingDurationSeconds',30,'usableFrames',20,'usableRatio',0.9,
      'modelVersion','pose_landmarker_lite_float16_v1','validationVersion','mylvl-pose-v1'
    )
  )
);
select pg_sleep(1);
commit;
