import test from "node:test";
import assert from "node:assert/strict";
import { ExerciseRepRecognizer, jointAngle } from "../src/poseRecognition.ts";
import { PlankHoldRecognizer } from "../src/plankRecognition.ts";

function frameFor(kind, angle, timestampMs, visibility = 0.98) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility }));
  if (kind === "squats") {
    points[11] = { x: 0.45, y: 0.15, visibility }; points[23] = { x: 0.5, y: 0.3, visibility };
    points[25] = { x: 0.5, y: 0.5, visibility }; points[27] = { x: 0.5 + 0.2 * Math.cos((angle - 90) * Math.PI / 180), y: 0.5 + 0.2 * Math.sin((angle - 90) * Math.PI / 180), visibility };
  } else if (kind === "situps") {
    points[23] = { x: 0.5, y: 0.5, visibility };
    points[25] = { x: 0.7, y: 0.5, visibility };
    points[11] = { x: 0.5 + 0.2 * Math.cos(angle * Math.PI / 180), y: 0.5 - 0.2 * Math.sin(angle * Math.PI / 180), visibility };
    points[13] = { x: 0.5, y: 0.6, visibility }; points[15] = { x: 0.4, y: 0.6, visibility };
    points[27] = { x: 0.8, y: 0.5, visibility };
  } else {
    points[11] = { x: 0.3, y: 0.4, visibility }; points[13] = { x: 0.4, y: 0.4, visibility };
    points[15] = angle > 150 ? { x: 0.5, y: 0.4, visibility } : { x: 0.4 + 0.1 * Math.cos((180 - angle) * Math.PI / 180), y: 0.4 + 0.1 * Math.sin((180 - angle) * Math.PI / 180), visibility };
    points[23] = { x: 0.5, y: 0.4, visibility }; points[25] = { x: 0.6, y: 0.4, visibility }; points[27] = { x: 0.7, y: 0.4, visibility };
  }
  // Give the opposite side the same complete pose; visibility selection is deterministic.
  for (const [left, right] of [[11,12],[13,14],[15,16],[23,24],[25,26],[27,28]]) points[right] = { ...points[left] };
  return { landmarks: points, width: 640, height: 480, timestampMs };
}

function runCycle(recognizer, kind, start) {
  let time = start;
  for (const angle of [170, 170, 170, 135, 110, 80, 80, 110, 140, 165, 170, 170]) {
    recognizer.process(frameFor(kind, angle, time)); time += 200;
  }
  return time;
}

function frontPushupFrame(angle, timestampMs, bodyShift = angle < 150 ? Math.min(0.045, (150 - angle) / 60 * 0.045) : 0, visibility = 0.98) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility }));
  const shoulderY = 0.35 + bodyShift;
  points[0] = { x: 0.5, y: 0.24 + bodyShift, visibility };
  points[11] = { x: 0.36, y: shoulderY, visibility };
  points[13] = { x: 0.42, y: shoulderY, visibility };
  points[15] = { x: 0.42 + 0.08 * Math.cos((180 - angle) * Math.PI / 180), y: shoulderY + 0.08 * Math.sin((180 - angle) * Math.PI / 180), visibility };
  points[12] = { x: 0.64, y: shoulderY, visibility };
  points[14] = { x: 0.58, y: shoulderY, visibility };
  points[16] = { x: 0.58 + 0.08 * Math.cos(angle * Math.PI / 180), y: shoulderY + 0.08 * Math.sin(angle * Math.PI / 180), visibility };
  return { landmarks: points, width: 640, height: 480, timestampMs };
}

function anchoredFrontPushupFrame(timestampMs, noseShift, shoulderShift) {
  const frame = frontPushupFrame(130, timestampMs, 0);
  frame.landmarks[0].y += noseShift;
  frame.landmarks[11].y += shoulderShift;
  frame.landmarks[12].y += shoulderShift;
  return frame;
}

test("joint angles are stable around straight and bent joints", () => {
  assert.equal(Math.round(jointAngle({x:0,y:0},{x:1,y:0},{x:2,y:0})), 180);
  assert.equal(Math.round(jointAngle({x:0,y:0},{x:1,y:0},{x:1,y:1})), 90);
});

for (const kind of ["pushups", "squats", "situps"]) {
  test(`${kind}: counts one full movement and no stationary pose`, () => {
    const recognizer = new ExerciseRepRecognizer(kind);
    for (let i=0; i<24; i++) recognizer.process(frameFor(kind, 170, 1000+i*200));
    assert.equal(recognizer.repetitions, 0);
    runCycle(recognizer, kind, 7000);
    assert.equal(recognizer.repetitions, 1);
    assert.equal(recognizer.finish(12).validationReady, true);
  });

  test(`${kind}: partial range, short movement and noise do not create repeated reps`, () => {
    const recognizer = new ExerciseRepRecognizer(kind);
    let time=1000;
    for (const angle of [170,170,170,137,136,138,136,137,170,170,170,170,170,170]) {
      recognizer.process(frameFor(kind,angle,time)); time+=100;
    }
    assert.equal(recognizer.repetitions,0);
  });
}

test("missing or low-visibility landmarks lower confidence and cannot validate", () => {
  const missing = new ExerciseRepRecognizer("squats");
  for (let i=0;i<14;i++) {
    const frame=frameFor("squats",170,1000+i*200);
    frame.landmarks[27].visibility=0.1; frame.landmarks[28].visibility=0.1;
    missing.process(frame);
  }
  const result=missing.finish(4);
  assert.equal(result.validationReady,false);
  assert.ok(result.usableRatio<0.65);
});

test("stationary frame jitter near the ready threshold cannot count a rep", () => {
  const recognizer=new ExerciseRepRecognizer("pushups");
  for(let i=0;i<100;i++) recognizer.process(frameFor("pushups", i%2?164:170, 1000+i*200));
  assert.equal(recognizer.repetitions,0);
});


test("front push-ups: preserves quick phases that the median filter would otherwise smooth away", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  for (const [index, angle] of [170, 170, 140, 100, 165, 170].entries()) {
    recognizer.process(frontPushupFrame(angle, 1000 + index * 100));
  }
  assert.equal(recognizer.repetitions, 1);
});

test("front push-ups: counts a slower full range cycle", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  const angles = [170, 170, 145, 120, 100, 120, 140, 150, 160, 170];
  angles.forEach((angle, index) => recognizer.process(frontPushupFrame(angle, 1000 + index * 300)));
  assert.equal(recognizer.repetitions, 1);
});

test("front push-ups: arm angle changes without head and shoulder travel do not count", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  for (const [index, angle] of [170, 170, 140, 100, 165, 170].entries()) {
    recognizer.process(frontPushupFrame(angle, 1000 + index * 100, 0));
  }
  assert.equal(recognizer.repetitions, 0);
});

test("front push-ups: head and shoulder travel can drive reps when the frontal arm angle barely changes", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  const shifts = [0, 0, 0.005, 0.02, 0.04, 0.055, 0.04, 0.02, 0.005, 0];
  shifts.forEach((shift, index) => recognizer.process(frontPushupFrame(130, 1000 + index * 120, shift)));
  assert.equal(recognizer.repetitions, 1);
});

test("front push-ups: a fast full upper-body cycle is counted", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  const shifts = [0, 0, 0.02, 0.055, 0.02, 0];
  shifts.forEach((shift, index) => recognizer.process(frontPushupFrame(130, 1000 + index * 100, shift)));
  assert.equal(recognizer.repetitions, 1);
});

test("front push-ups: small head movement and incomplete returns are not counted", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  const shifts = [0, 0, 0.004, 0.008, 0.012, 0.008, 0.004, 0];
  shifts.forEach((shift, index) => recognizer.process(frontPushupFrame(130, 1000 + index * 150, shift)));
  assert.equal(recognizer.repetitions, 0);

  const partial = new ExerciseRepRecognizer("pushups", "front");
  [0, 0, 0.02, 0.055, 0.04, 0.02].forEach((shift, index) =>
    partial.process(frontPushupFrame(130, 3000 + index * 150, shift)));
  assert.equal(partial.repetitions, 0);
});

test("front push-ups: counts fast reps when the rising frames are skipped", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  const shifts = [0, 0.055, 0, 0.055, 0];
  shifts.forEach((shift, index) => recognizer.process(frontPushupFrame(130, 5000 + index * 100, shift)));
  assert.equal(recognizer.repetitions, 2);
});

test("front push-ups: counts a brisk cycle from only top, bottom and top samples", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  [0, 0.055, 0].forEach((shift, index) =>
    recognizer.process(frontPushupFrame(130, 7000 + index * 100, shift)));
  assert.equal(recognizer.repetitions, 1);
});


test("front push-ups: follows the head anchor when it moves more clearly than the shoulders", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  [[0, 0], [0.055, 0], [0, 0]].forEach(([nose, shoulders], index) =>
    recognizer.process(anchoredFrontPushupFrame(9000 + index * 100, nose, shoulders)));
  assert.equal(recognizer.repetitions, 1);
});

test("front push-ups: follows the shoulder anchor when it moves more clearly than the head", () => {
  const recognizer = new ExerciseRepRecognizer("pushups", "front");
  [[0, 0], [0, 0.055], [0, 0]].forEach(([nose, shoulders], index) =>
    recognizer.process(anchoredFrontPushupFrame(10000 + index * 100, nose, shoulders)));
  assert.equal(recognizer.repetitions, 1);
});


function plankFrame(timestampMs, bent = false, visibility = 0.98) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility }));
  const shoulder = { x: 0.25, y: 0.35 };
  const hip = bent ? { x: 0.55, y: 0.49 } : { x: 0.55, y: 0.35 };
  const ankle = { x: 0.82, y: 0.35 };
  const knee = { x: 0.69, y: 0.35 };
  const elbow = { x: 0.25, y: 0.45 };
  const wrist = { x: 0.35, y: 0.45 };
  for (const [index, point] of [[11,shoulder],[13,elbow],[15,wrist],[23,hip],[25,knee],[27,ankle]]) points[index] = { ...point, visibility };
  for (const [left,right] of [[11,12],[13,14],[15,16],[23,24],[25,26],[27,28]]) points[right] = { ...points[left] };
  return { landmarks: points, width: 640, height: 480, timestampMs };
}

test("sit-ups count shoulder-to-hip cycles but ignore head-only movement", () => {
  const recognizer = new ExerciseRepRecognizer("situps", "side");
  runCycle(recognizer, "situps", 1000);
  assert.equal(recognizer.repetitions, 1);
  const headOnly = new ExerciseRepRecognizer("situps", "side");
  for (const angle of [170,170,170,170,170,170,170]) {
    const frame = frameFor("situps", 170, 5000 + headOnly.repetitions * 100);
    frame.landmarks[0].y = angle;
    headOnly.process(frame);
  }
  assert.equal(headOnly.repetitions, 0);
});

test("plank uses timestamped valid posture, pauses on lost posture, and stops bridging long gaps", () => {
  const recognizer = new PlankHoldRecognizer();
  for(let t=1000;t<=3000;t+=100) recognizer.process(plankFrame(t));
  const beforeBreak = recognizer.validSeconds;
  recognizer.process(plankFrame(3100,true));
  for(let t=10000;t<=12000;t+=100) recognizer.process(plankFrame(t));
  const afterBreak = recognizer.validSeconds;
  assert.ok(beforeBreak >= 1.5);
  assert.ok(afterBreak > beforeBreak);
  assert.ok(afterBreak < 5);
  const result = recognizer.finish(11);
  assert.equal(result.validationReady,true);
  assert.ok(result.invalidSeconds > 0);
});

test("plank does not credit time across a suspended or stalled camera frame", () => {
  const recognizer = new PlankHoldRecognizer();
  recognizer.process(plankFrame(1000));
  recognizer.process(plankFrame(2000));
  assert.equal(recognizer.validSeconds,0);
  const result=recognizer.finish(5);
  assert.equal(result.validationReady,false);
});
