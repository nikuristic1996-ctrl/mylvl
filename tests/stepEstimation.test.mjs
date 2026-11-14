import assert from "node:assert/strict";
import test from "node:test";
import { estimateRunningSteps, estimatedStepLength, parsePaceSecondsPerKm, personalizedStepLength } from "../src/stepEstimation.ts";
import { parseActivityScreenshot } from "../src/screenshotOcr.ts";

test("interpolates the documented 178 cm reference curve at its anchor paces", () => {
  assert.equal(estimatedStepLength(540), 0.75);
  assert.equal(estimatedStepLength(480), 0.85);
  assert.equal(estimatedStepLength(420), 0.95);
  assert.equal(estimatedStepLength(360), 1.05);
  assert.equal(estimatedStepLength(300), 1.2);
  assert.equal(estimatedStepLength(240), 1.4);
  assert.equal(estimatedStepLength(390), 1);
});

test("parses km and mile paces and lightly accounts for height", () => {
  assert.equal(parsePaceSecondsPerKm("7:00 min/km"), 420);
  assert.ok(Math.abs(parsePaceSecondsPerKm("11:16 min/mi") - 420) < 1);
  assert.ok(estimatedStepLength(420, 200) > estimatedStepLength(420, 150));
  assert.equal(estimatedStepLength(0), undefined);
});

test("estimates steps for decimal distances and rejects absent or invalid inputs", () => {
  const result = estimateRunningSteps({ type: "Running", distanceKm: 6.34, pace: "7:00 /km" });
  assert.equal(result.steps, 6674);
  assert.equal(result.source, "estimated");
  assert.equal(result.method, "pace");
  assert.equal(estimateRunningSteps({ type: "Running", distanceKm: 6.3 }).steps, null);
  assert.equal(estimateRunningSteps({ type: "Running", distanceKm: -1, pace: "7:00/km" }).steps, null);
  assert.equal(estimateRunningSteps({ type: "Walking", distanceKm: 6.3, pace: "7:00/km" }).steps, null);
});

test("missing measured steps in a Garmin OCR result uses the existing estimate without adding walking EXP", () => {
  const parsed = parseActivityScreenshot("Garmin Laufbandtraining Distanz 6,34 km Durchschnittspace 7:17 /km");
  assert.equal(parsed.steps, "");
  const result = estimateRunningSteps({ type: parsed.type, distanceKm: Number(parsed.distance), pace: parsed.pace });
  assert.equal(result.source, "estimated");
  assert.ok(result.steps > 0);
  assert.equal(result.method, "pace");
});

test("never replaces measured steps and prefers explicit cadence over estimates", () => {
  const actual = estimateRunningSteps({ type: "Running", distanceKm: 6.3, pace: "7:00/km", measuredSteps: 8123 });
  assert.deepEqual([actual.steps, actual.source, actual.method], [8123, "measured", "measured"]);
  const cadence = estimateRunningSteps({ type: "Running", distanceKm: 6.3, pace: "7:00/km", cadence: 160, cadenceUnit: "steps/min", movingDurationMinutes: 40 });
  assert.deepEqual([cadence.steps, cadence.method], [6400, "cadence"]);
  const strides = estimateRunningSteps({ type: "Running", cadence: 80, cadenceUnit: "strides/min", movingDurationMinutes: 40 });
  assert.equal(strides.steps, 6400);
  assert.equal(estimateRunningSteps({ type: "Running", cadence: 80, cadenceUnit: "strides/min" }).steps, null);
});

test("personal calibration needs three verified measured runs and uses the median", () => {
  const activities = [8000, 9000, 10000].map((steps, index) => ({
    id: String(index), type: "Running", date: "2026-11-01", duration: 30, distance: 8,
    steps, xp: 0, source: "screenshot", validationStatus: "user_confirmed", notes: "Steps source: measured",
  }));
  assert.equal(personalizedStepLength(activities), 0.889);
  const result = estimateRunningSteps({ type: "Running", distanceKm: 5, pace: "7:00/km", activities });
  assert.equal(result.method, "personalized");
  assert.equal(result.steps, Math.round(5000 / 0.889));
  assert.equal(personalizedStepLength(activities.slice(0, 2)), undefined);
});

test("very slow and fast paces stay within plausible heuristic bounds", () => {
  assert.ok(estimatedStepLength(120) <= 1.55);
  assert.ok(estimatedStepLength(1800) >= 0.55);
  assert.equal(estimatedStepLength(60), undefined);
  assert.equal(estimatedStepLength(3600), undefined);
});

