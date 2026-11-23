import test from "node:test";
import assert from "node:assert/strict";
import { parseCameraExerciseSubmission } from "../supabase/functions/_shared/cameraValidation.ts";
import { validateExerciseEstimate, calculateActivityXp } from "../supabase/functions/_shared/gameEngine.ts";
import { stopCameraTracks } from "../src/poseRuntime.ts";
import { prepareAward } from "../supabase/functions/_shared/awardService.ts";
import { readFile } from "node:fs/promises";

const cameraMigration = await readFile(new URL("../supabase/migrations/20261119230337_phase_6_camera_exercise.sql", import.meta.url), "utf8");
const toleranceMigration = await readFile(new URL("../supabase/migrations/20261120012504_camera_rep_tolerance.sql", import.meta.url), "utf8");
const phase65Migration = await readFile(new URL("../supabase/migrations/20261123210000_phase_6_5_camera_workouts.sql", import.meta.url), "utf8");
const awardEdge = await readFile(new URL("../supabase/functions/award-activity/index.ts", import.meta.url), "utf8");

const valid = (overrides={}) => ({
  sessionId:"d2719d5a-0d2a-4aca-8bb7-85e88c136e1f", exerciseType:"pushups", metricType:"repetitions", reportedReps:30, detectedReps:29,
  confidence:0.92, recordingDurationSeconds:31, modelVersion:"pose_landmarker_lite_float16_v1",
  validationVersion:"mylvl-pose-v1", usableFrames:80, usableRatio:0.94, deviationPercent:3.3333333333333335,
  ...overrides,
});

test("camera submission allows only a 10 percent estimate difference and EXP uses detected reps", () => {
  const result=parseCameraExerciseSubmission(valid({reportedReps:30, detectedReps:29, confidence:0.63, deviationPercent:3.3333333333333335}));
  assert.equal(result.ok,true);
  assert.equal(result.value.detectedAmount,29);
  assert.equal(validateExerciseEstimate({userEstimate:30, detectedAmount:29, confidence:0.63, minimumConfidence:0.60, maximumDeviationPercent:10}).status,"accepted");
  assert.equal(parseCameraExerciseSubmission(valid({reportedReps:10, detectedReps:6, confidence:0.63})).ok,false);
  const xp=calculateActivityXp({type:"pushups",source:"camera",recordedSession:true,metrics:{repetitions:100},
    exerciseValidation:{detectedAmount:29,userEstimate:30,confidence:0.63,minimumConfidence:0.60,maximumDeviationPercent:10}});
  assert.equal(xp.xp,145);
});

test("sit-up camera parsing requires a matching exercise type and accepts the 10 percent boundary", () => {
  assert.equal(parseCameraExerciseSubmission(valid({exerciseType:"situps",reportedReps:10,detectedReps:9,deviationPercent:10})).ok,true);
  assert.equal(parseCameraExerciseSubmission(valid({exerciseType:"squats",reportedReps:10,detectedReps:9}),"situps").ok,false);
});

test("plank camera parsing validates measured seconds and awards only completed 10 second blocks", () => {
  const meta={sessionId:"d2719d5a-0d2a-4aca-8bb7-85e88c136e1f",exerciseType:"plank",metricType:"hold_seconds",
    reportedHoldSeconds:30,detectedHoldSeconds:29,confidence:0.9,recordingDurationSeconds:35,
    modelVersion:"pose_landmarker_lite_float16_v1",validationVersion:"mylvl-pose-v1",usableFrames:30,usableRatio:0.9,deviationPercent:3.4482758620689653};
  const parsed=parseCameraExerciseSubmission(meta);
  assert.equal(parsed.ok,true);
  if(parsed.ok) {
    const award=calculateActivityXp({type:"plank",source:"camera",recordedSession:true,metrics:{holdSeconds:parsed.value.detectedAmount},
      exerciseValidation:{detectedAmount:parsed.value.detectedAmount,userEstimate:parsed.value.reportedAmount,confidence:0.9,minimumConfidence:0.6,maximumDeviationPercent:10}});
    assert.equal(award.xp,12);
  }
  assert.equal(parseCameraExerciseSubmission({...meta,reportedHoldSeconds:60}).ok,false);
  assert.equal(calculateActivityXp({type:"plank",source:"camera",recordedSession:true,metrics:{holdSeconds:9},
    exerciseValidation:{detectedAmount:9,userEstimate:9,confidence:0.9,minimumConfidence:0.6,maximumDeviationPercent:10}}).xp,6);
});
test("rejects zero, weak confidence, poor frames, excessive duration and mismatched deviation", () => {
  for (const value of [
    valid({reportedReps:0}), valid({detectedReps:0}), valid({confidence:0.59}),
    valid({usableFrames:11}), valid({usableRatio:0.64}), valid({recordingDurationSeconds:91}),
    valid({deviationPercent:22}), valid({sessionId:"not-a-uuid"}), valid({reportedReps:501}),
  ]) assert.equal(parseCameraExerciseSubmission(value).ok,false);
});

test("server engine awards from detected repetitions only and applies cap returns", () => {
  const args={type:"pushups",source:"camera",recordedSession:true,metrics:{repetitions:999},exerciseValidation:{detectedAmount:29,userEstimate:30,confidence:0.92,minimumConfidence:0.60}};
  assert.equal(calculateActivityXp(args).xp,145);
  assert.equal(calculateActivityXp({...args,dailyMetricBefore:95}).xp,55);
  const squat={...args,type:"squats",metrics:{repetitions:1000},exerciseValidation:{detectedAmount:40,userEstimate:40,confidence:0.92,minimumConfidence:0.60}};
  assert.equal(calculateActivityXp(squat).xp,120);
});

test("award service revalidates reserved camera metadata and uses detected reps", () => {
  const meta=valid();
  const reservation={status:"pending",activity_id:"activity-1",xp:0,daily_metric_before:0,activity:{
    activity_type:"pushups",source:"camera",source_key:meta.sessionId,validation_status:"pose_validated",
    repetitions:29,duration_minutes:1,metadata:{exercise_validation:meta},
  }};
  const award=prepareAward(reservation,meta.sessionId);
  assert.equal(award.xp,145);
  assert.equal(award.validationStatus,"pose_validated");
  assert.equal(award.metadata.measured_amount,29);
  assert.equal(prepareAward({...reservation,activity:{...reservation.activity,source_key:"different"}},meta.sessionId).xp,0);
});

test("camera stream cleanup stops every track", () => {
  const stopped=[];
  stopCameraTracks({getTracks:()=>[{stop:()=>stopped.push(1)},{stop:()=>stopped.push(2)}]});
  assert.deepEqual(stopped,[1,2]);
  assert.doesNotThrow(()=>stopCameraTracks(null));
});

test("camera award migration is additive, locked, idempotent and server-role-only", () => {
  assert.match(cameraMigration, /create or replace function public\.reserve_camera_exercise_award/i);
  assert.match(cameraMigration, /pg_advisory_xact_lock/i);
  assert.match(cameraMigration, /source='camera' and source_key=v_session::text/i);
  assert.match(cameraMigration, /on conflict do nothing/i);
  assert.match(cameraMigration, /where user_id = p_user_id and request_key = p_request_key/i);
  assert.match(cameraMigration, /grant execute on function public\.reserve_camera_exercise_award[\s\S]*to service_role/i);
  assert.match(cameraMigration, /revoke all on function public\.reserve_camera_exercise_award[\s\S]*from public,anon,authenticated/i);
  assert.doesNotMatch(cameraMigration, /\b(drop\s+table|truncate\s+|delete\s+from)\b/i);
});

test("Edge Function authenticates before reserving camera awards and never accepts client EXP", () => {
  assert.match(awardEdge, /auth\.getUser\(token\)/);
  assert.match(awardEdge, /reserve_camera_exercise_award/);
  assert.match(awardEdge, /parseCameraExerciseSubmission/);
  assert.doesNotMatch(awardEdge, /incoming\.xp/);
});


test("production tolerance migration changes validation only and keeps awards based on detected reps", () => {
  assert.match(toleranceMigration, /v_confidence < 0\.60/);
  assert.match(toleranceMigration, /greatest\(1,v_reported,v_detected\) > 0\.50/);
  assert.match(toleranceMigration, /v_metric_amount := v_detected/);
  assert.doesNotMatch(toleranceMigration, /\b(drop\s+table|truncate\s+|delete\s+from)\b/i);
});

test("production tolerance migration changes validation only and keeps awards based on detected reps", () => {
  assert.match(toleranceMigration, /v_confidence < 0\.60/);
  assert.match(toleranceMigration, /greatest\(1,v_reported,v_detected\) > 0\.50/);
  assert.match(toleranceMigration, /v_metric_amount := v_detected/);
  assert.doesNotMatch(toleranceMigration, /\b(drop\s+table|truncate\s+|delete\s+from)\b/i);
});

test("Phase 6.5 migration supports four workouts, persists plank seconds, and remains service-only", () => {
  assert.match(phase65Migration, /v_type not in \('pushups','squats','situps','plank'\)/i);
  assert.match(phase65Migration, /greatest\(1,v_reported_amount,v_detected_amount\) > 0\.10/i);
  assert.match(phase65Migration, /hold_seconds/i);
  assert.match(phase65Migration, /'holdSeconds'/);
  assert.match(phase65Migration, /pg_advisory_xact_lock/i);
  assert.match(phase65Migration, /on conflict do nothing/i);
  assert.match(phase65Migration, /grant execute on function public\.reserve_camera_exercise_award[\s\S]*to service_role/i);
  assert.match(phase65Migration, /revoke all on function public\.reserve_camera_exercise_award[\s\S]*from public,anon,authenticated/i);
  assert.doesNotMatch(phase65Migration, /\b(drop\s+table|truncate\s+|delete\s+from)\b/i);
});
