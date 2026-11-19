import test from "node:test";
import assert from "node:assert/strict";
import { ExerciseRepRecognizer, jointAngle } from "../src/poseRecognition.ts";

function frameFor(kind, angle, timestampMs, visibility = 0.98) {
  const points = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility }));
  if (kind === "squats") {
    points[11] = { x: 0.45, y: 0.15, visibility }; points[23] = { x: 0.5, y: 0.3, visibility };
    points[25] = { x: 0.5, y: 0.5, visibility }; points[27] = { x: 0.5 + 0.2 * Math.cos((angle - 90) * Math.PI / 180), y: 0.5 + 0.2 * Math.sin((angle - 90) * Math.PI / 180), visibility };
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

test("joint angles are stable around straight and bent joints", () => {
  assert.equal(Math.round(jointAngle({x:0,y:0},{x:1,y:0},{x:2,y:0})), 180);
  assert.equal(Math.round(jointAngle({x:0,y:0},{x:1,y:0},{x:1,y:1})), 90);
});

for (const kind of ["pushups", "squats"]) {
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

