import { SEASON_RULES_V1 } from "./gameEngine.ts";

export type TrendPoint = { period: string; activities: number; xp: number };
export type ProgressionStats = {
  totalActivities: number;
  runningDistanceKm: number;
  measuredRunningSteps: number;
  estimatedRunningSteps: number;
  xpByActivityType: Record<string, number>;
  weeklyTrend: TrendPoint[];
  monthlyTrend: TrendPoint[];
};

export const EMPTY_PROGRESSION_STATS: ProgressionStats = {
  totalActivities: 0,
  runningDistanceKm: 0,
  measuredRunningSteps: 0,
  estimatedRunningSteps: 0,
  xpByActivityType: {},
  weeklyTrend: [],
  monthlyTrend: [],
};

function finiteNumber(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function trendPoints(value: unknown): TrendPoint[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TrendPoint[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.period !== "string") return [];
    return [{ period: row.period, activities: finiteNumber(row.activities), xp: finiteNumber(row.xp) }];
  });
}

export function normalizeProgressionStats(value: unknown): ProgressionStats {
  if (!value || typeof value !== "object") return { ...EMPTY_PROGRESSION_STATS };
  const row = value as Record<string, unknown>;
  const xpByActivityType: Record<string, number> = {};
  if (row.xpByActivityType && typeof row.xpByActivityType === "object") {
    for (const [type, xp] of Object.entries(row.xpByActivityType)) xpByActivityType[type] = finiteNumber(xp);
  }
  return {
    totalActivities: finiteNumber(row.totalActivities),
    runningDistanceKm: finiteNumber(row.runningDistanceKm),
    measuredRunningSteps: finiteNumber(row.measuredRunningSteps),
    estimatedRunningSteps: finiteNumber(row.estimatedRunningSteps),
    xpByActivityType,
    weeklyTrend: trendPoints(row.weeklyTrend),
    monthlyTrend: trendPoints(row.monthlyTrend),
  };
}

export function seasonRankProgress(seasonXp: number) {
  const totalXp = finiteNumber(seasonXp);
  const ranks = SEASON_RULES_V1.rankThresholds;
  let index = 0;
  for (let cursor = 0; cursor < ranks.length; cursor += 1) {
    if (totalXp >= ranks[cursor].xp) index = cursor;
  }
  const current = ranks[Math.max(0, index)];
  const next = ranks[index + 1];
  return {
    rank: current.rank,
    currentXp: totalXp,
    nextRank: next?.rank ?? null,
    nextRankXp: next?.xp ?? current.xp,
    progressPercent: next
      ? Math.min(100, Math.max(0, ((totalXp - current.xp) / (next.xp - current.xp)) * 100))
      : 100,
    xpRemaining: next ? Math.max(0, next.xp - totalXp) : 0,
  };
}

export function seasonCountdown(target: string, nowMs = Date.now()) {
  const targetMs = new Date(target).getTime();
  if (!Number.isFinite(targetMs)) return null;
  const remainingMs = Math.max(0, targetMs - nowMs);
  return {
    expired: targetMs <= nowMs,
    days: Math.floor(remainingMs / 86_400_000),
    hours: Math.floor((remainingMs % 86_400_000) / 3_600_000),
  };
}

const rankOrder = ["Bronze", "Silver", "Gold", "Platinum", "Diamond"];
export function highestHistoricalSeasonRank(ranks: string[]): string | null {
  return ranks.filter((rank) => rankOrder.includes(rank))
    .sort((a, b) => rankOrder.indexOf(b) - rankOrder.indexOf(a))[0] ?? null;
}

