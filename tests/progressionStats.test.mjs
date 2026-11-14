import assert from "node:assert/strict";
import test from "node:test";
import { highestHistoricalSeasonRank, normalizeProgressionStats, seasonCountdown, seasonRankProgress } from "../src/progressionStats.ts";

test("normalizes the secure dashboard response and keeps empty accounts at zero", () => {
  assert.deepEqual(normalizeProgressionStats(null), {
    totalActivities: 0, runningDistanceKm: 0, measuredRunningSteps: 0,
    estimatedRunningSteps: 0, xpByActivityType: {}, weeklyTrend: [], monthlyTrend: [],
  });
  const stats = normalizeProgressionStats({
    totalActivities: "3", runningDistanceKm: "12.5", measuredRunningSteps: 9000,
    estimatedRunningSteps: 1200, xpByActivityType: { Running: "630", Walking: -4 },
    weeklyTrend: [{ period: "2026-11-14", activities: "1", xp: 630 }, { activities: 4 }],
    monthlyTrend: [{ period: "2026-11", activities: 3, xp: 630 }],
  });
  assert.equal(stats.totalActivities, 3);
  assert.equal(stats.xpByActivityType.Running, 630);
  assert.equal(stats.xpByActivityType.Walking, 0);
  assert.deepEqual(stats.weeklyTrend, [{ period: "2026-11-14", activities: 1, xp: 630 }]);
  assert.equal(stats.monthlyTrend[0].period, "2026-11");
});

test("calculates seasonal rank thresholds and progress from trusted seasonal EXP", () => {
  assert.deepEqual([0, 4999, 5000, 10000, 15000, 20000].map(seasonRankProgress).map((item) => item.rank),
    ["Bronze", "Bronze", "Silver", "Gold", "Platinum", "Diamond"]);
  assert.equal(seasonRankProgress(4999).xpRemaining, 1);
  assert.equal(seasonRankProgress(5000).nextRankXp, 10000);
  assert.equal(seasonRankProgress(20000).nextRank, null);
  assert.equal(seasonRankProgress(20000).progressPercent, 100);
});

test("calculates remaining season time from UTC timestamps", () => {
  const now = Date.parse("2026-11-14T00:00:00Z");
  assert.deepEqual(seasonCountdown("2026-11-15T02:30:00Z", now), { expired: false, days: 1, hours: 2 });
  assert.deepEqual(seasonCountdown("2026-11-13T00:00:00Z", now), { expired: true, days: 0, hours: 0 });
  assert.equal(seasonCountdown("not a date", now), null);
});

test("shows the highest rank recorded in past seasons", () => {
  assert.equal(highestHistoricalSeasonRank(["Bronze", "Gold", "Silver"]), "Gold");
  assert.equal(highestHistoricalSeasonRank(["unknown"]), null);
});

