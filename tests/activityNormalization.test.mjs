import assert from "node:assert/strict";
import test from "node:test";
import { calculateActivityXp, normalizeActivityType } from "../src/gameEngine.ts";

test("activity labels with different casing normalize to one canonical type", () => {
  for (const value of ["Running", "running", "RUNNING", "  RuNnInG  "]) {
    assert.equal(normalizeActivityType(value), "running");
  }
  assert.equal(normalizeActivityType("Push-ups"), "pushups");
  assert.equal(normalizeActivityType("not-a-real-activity"), null);
  assert.equal(normalizeActivityType("Other"), null);
});

test("concurrent casing variants share one daily EXP allowance", async () => {
  // Mirrors the serialized database key: user + local day + canonical activity type.
  const mutexes = new Map();
  const dailyMetrics = new Map();
  const reserveAndCalculate = async (label, distanceKm) => {
    const type = normalizeActivityType(label);
    assert.ok(type);
    const key = `test-user:2026-11-13:${type}`;
    const previous = mutexes.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    mutexes.set(key, previous.then(() => current));
    await previous;
    try {
      const before = dailyMetrics.get(key) ?? 0;
      const result = calculateActivityXp({
        type,
        source: "screenshot",
        screenshotConfirmed: true,
        metrics: { distanceKm, durationMinutes: 90 },
        dailyMetricBefore: before,
      });
      dailyMetrics.set(key, before + distanceKm);
      return result.xp;
    } finally {
      release();
    }
  };

  const xp = await Promise.all([
    reserveAndCalculate("Running", 20),
    reserveAndCalculate("running", 20),
    reserveAndCalculate("RUNNING", 20),
  ]);
  assert.equal(new Set(["Running", "running", "RUNNING"].map(normalizeActivityType)).size, 1);
  assert.equal(dailyMetrics.get("test-user:2026-11-13:running"), 60);
  assert.equal(xp.reduce((sum, amount) => sum + amount, 0), 4500);
});

