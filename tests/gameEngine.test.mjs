import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_RULES_V1,
  ACTIVITY_TYPES,
  XP_RULES_VERSION,
  calculateActivityXp,
  permanentProgressForXp,
  permanentXpThreshold,
  seasonProgressForXp,
  validateExerciseEstimate,
  reconcileDailySteps,
} from "../src/gameEngine.ts";

const recorded = (type, metrics, extra = {}) =>
  calculateActivityXp({
    type,
    source: "provider",
    recordedSession: true,
    ...(type === "walking" ? { dailyStepsReconciled: true } : {}),
    metrics,
    ...extra,
  });

test("V1 exposes exactly the 12 configured activity rules", () => {
  assert.equal(ACTIVITY_TYPES.length, 12);
  assert.deepEqual(Object.keys(ACTIVITY_RULES_V1), [...ACTIVITY_TYPES]);
  assert.equal(XP_RULES_VERSION, "1.0.0");
});

test("calculates the configured EXP for all 12 activities", () => {
  const cases = [
    ["running", { distanceKm: 5.5 }, 550],
    ["walking", { steps: 14500 }, 725],
    ["cycling", { distanceKm: 10 }, 200],
    ["swimming", { distanceMeters: 500 }, 250],
    ["strength", { durationMinutes: 60, activeCalories: 360 }, 216],
    ["yoga", { durationMinutes: 60 }, 120],
    ["pilates", { durationMinutes: 30 }, 60],
    ["pushups", { repetitions: 30 }, 150],
    ["squats", { repetitions: 20 }, 60],
    ["situps", { repetitions: 25 }, 50],
    ["plank", { holdSeconds: 60 }, 36],
    ["pullups", { repetitions: 10 }, 80],
  ];
  for (const [type, metrics, xp] of cases) {
    const result = recorded(type, metrics, {
      ...(ACTIVITY_RULES_V1[type].exerciseValidationRequired
        ? {
            source: "camera",
            exerciseValidation: {
              detectedAmount: metrics.repetitions ?? metrics.holdSeconds,
              userEstimate: metrics.repetitions ?? metrics.holdSeconds,
              confidence: 0.95,
            },
          }
        : {}),
    });
    assert.equal(result.xp, xp, `${type} XP`);
    assert.equal(result.status, "eligible", `${type} eligibility`);
  }
});

test("rounds fractional activity EXP only after calculating the activity", () => {
  assert.equal(recorded("running", { distanceKm: 1.235 }).xp, 124);
  assert.equal(recorded("walking", { steps: 125 }).xp, 6);
  assert.equal(recorded("yoga", { durationMinutes: 2.25 }).xp, 5);
});

test("requires evidence and user confirmation for screenshot-derived activity", () => {
  const manual = calculateActivityXp({
    type: "running",
    source: "manual",
    metrics: { distanceKm: 5 },
  });
  assert.equal(manual.status, "ineligible");
  assert.equal(manual.xp, 0);

  const unconfirmed = calculateActivityXp({
    type: "running",
    source: "screenshot",
    metrics: { distanceKm: 5 },
  });
  assert.equal(unconfirmed.status, "requires-review");

  const confirmed = calculateActivityXp({
    type: "running",
    source: "screenshot",
    screenshotConfirmed: true,
    metrics: { distanceKm: 5 },
  });
  assert.equal(confirmed.xp, 500);
  assert.equal(confirmed.validation, "user-confirmed");
});

test("requires a recorded session for recorded activity providers", () => {
  const result = calculateActivityXp({
    type: "running",
    source: "provider",
    metrics: { distanceKm: 5 },
  });
  assert.equal(result.status, "ineligible");
  assert.equal(result.xp, 0);
});

test("uses base strength rate when active calories are missing and rejects invalid calories", () => {
  const fallback = recorded("strength", { durationMinutes: 10 });
  assert.equal(fallback.xp, 30);
  assert.match(fallback.warnings[0], /fallback/);

  const invalid = recorded("strength", { durationMinutes: 10, activeCalories: -1 });
  assert.equal(invalid.status, "requires-review");
  assert.equal(invalid.xp, 0);
});

test("applies diminishing returns only to the amount above the daily threshold", () => {
  const running = recorded("running", { distanceKm: 3 }, { dailyMetricBefore: 29 });
  assert.equal(running.xp, 200);
  const walking = recorded("walking", { steps: 2000 }, { dailyMetricBefore: 19000 });
  assert.equal(walking.xp, 63);
});

test("holds daily step EXP until running steps are reconciled and subtracts them exactly", () => {
  assert.deepEqual(reconcileDailySteps(14500), {
    eligibleSteps: 0,
    status: "pending-reconciliation",
  });
  assert.deepEqual(reconcileDailySteps(14500, 6200), {
    eligibleSteps: 8300,
    status: "reconciled",
  });
  assert.equal(recorded("walking", { steps: 8300 }).xp, 415);
  assert.equal(reconcileDailySteps(100, 200).eligibleSteps, 0);
  assert.equal(reconcileDailySteps(-1, 0).status, "invalid");
});

test("exercise validation permits a 50 percent honest count difference and rejects larger differences", () => {
  assert.equal(validateExerciseEstimate({ detectedAmount: 10, userEstimate: 11, confidence: 0.9 }).status, "accepted");
  assert.equal(validateExerciseEstimate({ detectedAmount: 6, userEstimate: 10, confidence: 0.63, minimumConfidence: 0.60 }).status, "accepted");
  assert.equal(validateExerciseEstimate({ detectedAmount: 10, userEstimate: 20, confidence: 0.9 }).status, "accepted");
  assert.equal(validateExerciseEstimate({ detectedAmount: 10, userEstimate: 21, confidence: 0.9 }).status, "review");
  assert.equal(validateExerciseEstimate({ detectedAmount: 10, userEstimate: 10, confidence: 0.2 }).status, "inconclusive");
  assert.equal(validateExerciseEstimate({ detectedAmount: 0, userEstimate: 4, confidence: 0.9 }).status, "rejected");
});

test("uses detected exercise count, never the user's estimate, for EXP", () => {
  const result = calculateActivityXp({
    type: "pushups",
    source: "camera",
    recordedSession: true,
    metrics: { repetitions: 999 },
    exerciseValidation: { detectedAmount: 20, userEstimate: 20, confidence: 0.95 },
  });
  assert.equal(result.xp, 100);
});

test("permanent levels match the specified cumulative thresholds and preserve lifetime XP", () => {
  assert.equal(permanentXpThreshold(1), 0);
  assert.equal(permanentXpThreshold(10), 6300);
  assert.equal(permanentXpThreshold(20), 18050);
  assert.equal(permanentXpThreshold(50), 83300);
  assert.equal(permanentXpThreshold(100), 292050);
  assert.deepEqual(permanentProgressForXp(6300), {
    level: 10,
    totalXp: 6300,
    currentXp: 0,
    neededXp: 950,
    nextLevelXp: 7250,
    current: 0,
    needed: 950,
  });
  assert.equal(permanentProgressForXp(-3).level, 1);
});

test("season levels cap at 50 while rank and total season EXP keep progressing", () => {
  assert.deepEqual(seasonProgressForXp(0), {
    totalXp: 0,
    level: 1,
    currentXp: 0,
    neededXp: 500,
    rank: "Bronze",
    capped: false,
  });
  assert.equal(seasonProgressForXp(5000).rank, "Silver");
  assert.equal(seasonProgressForXp(10000).rank, "Gold");
  assert.equal(seasonProgressForXp(15000).rank, "Platinum");
  assert.equal(seasonProgressForXp(20000).rank, "Diamond");
  const capped = seasonProgressForXp(25500);
  assert.equal(capped.level, 50);
  assert.equal(capped.totalXp, 25500);
  assert.equal(capped.currentXp, 500);
  assert.equal(capped.rank, "Diamond");
  assert.equal(capped.capped, true);
});

