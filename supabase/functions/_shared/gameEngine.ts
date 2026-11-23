/**
 * Pure, versioned V1 game rules. This module deliberately has no browser,
 * database, or UI dependencies so it can be reused by trusted award logic.
 */
export const XP_RULES_VERSION = "1.0.0" as const;

export const ACTIVITY_TYPES = [
  "running",
  "walking",
  "cycling",
  "swimming",
  "strength",
  "yoga",
  "pilates",
  "pushups",
  "squats",
  "situps",
  "plank",
  "pullups",
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Normalize UI labels and casing to the one canonical engine activity type. */
export function normalizeActivityType(value: unknown): ActivityType | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[\s_-]+/g, "");
  const aliases: Readonly<Record<string, ActivityType>> = {
    walking: "walking", running: "running", cycling: "cycling", swimming: "swimming",
    strength: "strength", yoga: "yoga", pilates: "pilates", pushups: "pushups",
    squats: "squats", situps: "situps", plank: "plank", pullups: "pullups",
  };
  return aliases[key] ?? null;
}
export type ActivitySource = "provider" | "screenshot" | "camera" | "manual" | "nose_counter";
export type ActivityMetrics = {
  distanceKm?: number;
  steps?: number;
  distanceMeters?: number;
  durationMinutes?: number;
  repetitions?: number;
  holdSeconds?: number;
  activeCalories?: number;
};

type MetricKey = keyof ActivityMetrics;
type ActivityRule = {
  metric: MetricKey;
  unitSize: number;
  xpPerUnit: number;
  dailyCap: number;
  afterCapMultiplier: number;
  sessionRequired: boolean;
  missingActiveCaloriesMultiplier?: number;
  exerciseValidationRequired?: boolean;
};

export const ACTIVITY_RULES_V1: Readonly<Record<ActivityType, Readonly<ActivityRule>>> =
  Object.freeze({
    running: Object.freeze({ metric: "distanceKm", unitSize: 1, xpPerUnit: 100, dailyCap: 30, afterCapMultiplier: 0.5, sessionRequired: true }),
    walking: Object.freeze({ metric: "steps", unitSize: 1000, xpPerUnit: 50, dailyCap: 20000, afterCapMultiplier: 0.25, sessionRequired: true }),
    cycling: Object.freeze({ metric: "distanceKm", unitSize: 1, xpPerUnit: 20, dailyCap: 100, afterCapMultiplier: 0.5, sessionRequired: true }),
    swimming: Object.freeze({ metric: "distanceMeters", unitSize: 100, xpPerUnit: 50, dailyCap: 5000, afterCapMultiplier: 0.5, sessionRequired: true }),
    strength: Object.freeze({ metric: "durationMinutes", unitSize: 10, xpPerUnit: 30, dailyCap: 120, afterCapMultiplier: 0.25, sessionRequired: true, missingActiveCaloriesMultiplier: 1 }),
    yoga: Object.freeze({ metric: "durationMinutes", unitSize: 10, xpPerUnit: 20, dailyCap: 120, afterCapMultiplier: 0.25, sessionRequired: true }),
    pilates: Object.freeze({ metric: "durationMinutes", unitSize: 10, xpPerUnit: 20, dailyCap: 120, afterCapMultiplier: 0.25, sessionRequired: true }),
    pushups: Object.freeze({ metric: "repetitions", unitSize: 1, xpPerUnit: 5, dailyCap: 100, afterCapMultiplier: 0.25, sessionRequired: true, exerciseValidationRequired: true }),
    squats: Object.freeze({ metric: "repetitions", unitSize: 1, xpPerUnit: 3, dailyCap: 150, afterCapMultiplier: 0.25, sessionRequired: true, exerciseValidationRequired: true }),
    situps: Object.freeze({ metric: "repetitions", unitSize: 1, xpPerUnit: 2, dailyCap: 150, afterCapMultiplier: 0.25, sessionRequired: true, exerciseValidationRequired: true }),
    plank: Object.freeze({ metric: "holdSeconds", unitSize: 10, xpPerUnit: 6, dailyCap: 600, afterCapMultiplier: 0.25, sessionRequired: true, exerciseValidationRequired: true }),
    pullups: Object.freeze({ metric: "repetitions", unitSize: 1, xpPerUnit: 8, dailyCap: 50, afterCapMultiplier: 0.25, sessionRequired: true, exerciseValidationRequired: true }),
  });

export const STRENGTH_INTENSITY_RULES = Object.freeze([
  { belowKcalPerMinute: 3, multiplier: 0.75 },
  { belowKcalPerMinute: 5, multiplier: 1 },
  { belowKcalPerMinute: 8, multiplier: 1.2 },
  { belowKcalPerMinute: Number.POSITIVE_INFINITY, multiplier: 1.4 },
]);

export type ExerciseValidation = {
  detectedAmount: number;
  userEstimate: number;
  confidence: number;
  minimumConfidence?: number;
};

export type ExerciseValidationResult = {
  status: "accepted" | "review" | "inconclusive" | "rejected";
  deviationPercent: number | null;
  detectedAmount: number;
  confidence: number;
};

export function validateExerciseEstimate(
  validation: ExerciseValidation,
): ExerciseValidationResult {
  const { detectedAmount, userEstimate, confidence } = validation;
  if (
    !Number.isFinite(detectedAmount) ||
    !Number.isFinite(userEstimate) ||
    !Number.isFinite(confidence) ||
    detectedAmount < 0 ||
    userEstimate < 0 ||
    confidence < 0 ||
    confidence > 1
  ) {
    return { status: "inconclusive", deviationPercent: null, detectedAmount: 0, confidence: 0 };
  }
  if (detectedAmount === 0) {
    return { status: "rejected", deviationPercent: null, detectedAmount, confidence };
  }
  const deviationPercent =
    (Math.abs(userEstimate - detectedAmount) / Math.max(1, userEstimate, detectedAmount)) * 100;
  if (confidence < (validation.minimumConfidence ?? 0.7)) {
    return { status: "inconclusive", deviationPercent, detectedAmount, confidence };
  }
  return {
    status: deviationPercent <= 50 ? "accepted" : "review",
    deviationPercent,
    detectedAmount,
    confidence,
  };
}

export type ActivityXpInput = {
  type: ActivityType;
  source: ActivitySource;
  metrics: ActivityMetrics;
  /** Metrics already rewarded for this activity type on the user's local day. */
  dailyMetricBefore?: number;
  /** User confirmation is required before screenshot-derived data can earn XP. */
  screenshotConfirmed?: boolean;
  /** Demo/mock extraction is never eligible for live EXP. */
  demo?: boolean;
  /** Walking EXP stays pending until running-session steps have been reconciled. */
  dailyStepsReconciled?: boolean;
  /** Must be true for a provider/camera/self-reported session; manual values never qualify. */
  recordedSession?: boolean;
  /** Explicit confirmation stored by the server for a Nose Counter set. */
  noseCounterConfirmed?: boolean;
  exerciseValidation?: ExerciseValidation;
};

export type ActivityXpResult = {
  xp: number;
  status: "eligible" | "requires-review" | "ineligible";
  validation: "provider-recorded" | "user-confirmed" | "pose-validated" | "none";
  ruleVersion: typeof XP_RULES_VERSION;
  measuredAmount: number;
  metric: MetricKey;
  warnings: string[];
  reason?: string;
};

function blockedResult(
  type: ActivityType,
  reason: string,
  status: "requires-review" | "ineligible" = "ineligible",
): ActivityXpResult {
  return {
    xp: 0,
    status,
    validation: "none",
    ruleVersion: XP_RULES_VERSION,
    measuredAmount: 0,
    metric: ACTIVITY_RULES_V1[type].metric,
    warnings: [],
    reason,
  };
}

function strengthMultiplier(
  durationMinutes: number,
  activeCalories: number | undefined,
  missingCaloriesMultiplier: number,
) {
  if (activeCalories === undefined) return { multiplier: missingCaloriesMultiplier, missing: true };
  if (!Number.isFinite(activeCalories) || activeCalories < 0 || durationMinutes <= 0) {
    return { multiplier: 1, invalid: true };
  }
  const rate = activeCalories / durationMinutes;
  const band = STRENGTH_INTENSITY_RULES.find((item) => rate < item.belowKcalPerMinute)!;
  return { multiplier: band.multiplier, missing: false };
}

/** Calculates a preview/reward candidate; trusted server code must perform awards. */
export function calculateActivityXp(input: ActivityXpInput): ActivityXpResult {
  const rule = ACTIVITY_RULES_V1[input.type];
  const value = rule.exerciseValidationRequired && input.exerciseValidation
    ? input.exerciseValidation.detectedAmount
    : input.metrics[rule.metric];
  if (input.source === "manual") return blockedResult(input.type, "Manual values are not eligible for EXP.");
  if (input.demo) return blockedResult(input.type, "Demo or mock activity data cannot earn EXP.");
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return blockedResult(input.type, `Enter a valid ${rule.metric} value.`);
  }
  if (input.source === "screenshot" && !input.screenshotConfirmed) {
    return blockedResult(input.type, "Confirm the screenshot-derived details before earning EXP.", "requires-review");
  }
  if (input.source !== "screenshot" && !input.recordedSession) {
    return blockedResult(input.type, "A recorded or provider-synced session is required.");
  }
  if (input.type === "walking" && !input.dailyStepsReconciled) {
    return blockedResult(input.type, "Daily steps are pending reconciliation with running-session steps.", "requires-review");
  }

  let validation: ActivityXpResult["validation"] =
    input.source === "screenshot" || input.source === "nose_counter" ? "user-confirmed" : "provider-recorded";
  if (rule.exerciseValidationRequired) {
    if (input.source === "nose_counter") {
      if (input.type !== "pushups" || input.noseCounterConfirmed !== true || !input.recordedSession) {
        return blockedResult(input.type, "A confirmed Nose Counter push-up set is required.", "requires-review");
      }
      validation = "user-confirmed";
    } else {
      if (input.source !== "camera" || !input.exerciseValidation) {
        return blockedResult(input.type, "Local camera validation is required.", "requires-review");
      }
      const result = validateExerciseEstimate(input.exerciseValidation);
      if (result.status !== "accepted") {
        return blockedResult(input.type, `Exercise validation status: ${result.status}.`, "requires-review");
      }
      validation = "pose-validated";
    }
  }

  const metricAmount = value;
  if (input.dailyMetricBefore !== undefined && !Number.isFinite(input.dailyMetricBefore)) {
    return blockedResult(input.type, "Previously rewarded daily amount is invalid.", "requires-review");
  }
  const already = Math.max(0, input.dailyMetricBefore ?? 0);
  const fullAmount = Math.min(metricAmount, Math.max(0, rule.dailyCap - already));
  const reducedAmount = metricAmount - fullAmount;
  let intensity = 1;
  const warnings: string[] = [];
  if (input.type === "strength") {
    const result = strengthMultiplier(
      input.metrics.durationMinutes ?? 0,
      input.metrics.activeCalories,
      rule.missingActiveCaloriesMultiplier ?? 1,
    );
    if (result.invalid) return blockedResult(input.type, "Active calorie data is invalid; review the session.", "requires-review");
    intensity = result.multiplier;
    if (result.missing) warnings.push("Active calories are missing; the configurable base-rate fallback is used.");
  }
  const xp = Math.round(
    ((fullAmount + reducedAmount * rule.afterCapMultiplier) / rule.unitSize) *
      rule.xpPerUnit *
      intensity,
  );
  return {
    xp,
    status: "eligible",
    validation,
    ruleVersion: XP_RULES_VERSION,
    measuredAmount: metricAmount,
    metric: rule.metric,
    warnings,
  };
}

export type DailyStepReconciliation = {
  eligibleSteps: number;
  status: "reconciled" | "pending-reconciliation" | "invalid";
};

/** Subtracts running steps to prevent counting them again as general steps. */
export function reconcileDailySteps(
  totalDailySteps: number,
  runningSessionSteps?: number,
): DailyStepReconciliation {
  if (!Number.isFinite(totalDailySteps) || totalDailySteps < 0) {
    return { eligibleSteps: 0, status: "invalid" };
  }
  if (runningSessionSteps === undefined) {
    return { eligibleSteps: 0, status: "pending-reconciliation" };
  }
  if (!Number.isFinite(runningSessionSteps) || runningSessionSteps < 0) {
    return { eligibleSteps: 0, status: "invalid" };
  }
  return {
    eligibleSteps: Math.max(0, totalDailySteps - runningSessionSteps),
    status: "reconciled",
  };
}

function normalizeXp(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Cumulative EXP threshold needed to reach the given permanent level. */
export function permanentXpThreshold(level: number): number {
  if (!Number.isInteger(level) || level < 1) throw new RangeError("Level must be a positive integer.");
  const n = level - 1;
  return 500 * n + 25 * n * (n - 1);
}

export type PermanentProgress = {
  level: number;
  totalXp: number;
  currentXp: number;
  neededXp: number;
  nextLevelXp: number;
  /** Compatibility aliases used by the existing level progress card. */
  current: number;
  needed: number;
};

export function permanentProgressForXp(totalXp: number): PermanentProgress {
  const xp = normalizeXp(totalXp);
  let low = 1;
  let high = 2;
  while (permanentXpThreshold(high) <= xp) high *= 2;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (permanentXpThreshold(mid) <= xp) low = mid;
    else high = mid;
  }
  const currentXp = xp - permanentXpThreshold(low);
  const nextLevelXp = permanentXpThreshold(low + 1);
  const neededXp = nextLevelXp - permanentXpThreshold(low);
  return { level: low, totalXp: xp, currentXp, neededXp, nextLevelXp, current: currentXp, needed: neededXp };
}

export const SEASON_RULES_V1 = Object.freeze({
  version: "1.0.0",
  durationDays: 84,
  xpPerLevel: 500,
  maxLevel: 50,
  rankThresholds: Object.freeze([
    { rank: "Bronze", xp: 0 },
    { rank: "Silver", xp: 5000 },
    { rank: "Gold", xp: 10000 },
    { rank: "Platinum", xp: 15000 },
    { rank: "Diamond", xp: 20000 },
  ]),
});

export type SeasonProgress = {
  totalXp: number;
  level: number;
  currentXp: number;
  neededXp: number;
  rank: (typeof SEASON_RULES_V1.rankThresholds)[number]["rank"];
  capped: boolean;
};

export function seasonProgressForXp(seasonXp: number): SeasonProgress {
  const totalXp = normalizeXp(seasonXp);
  const level = Math.min(
    SEASON_RULES_V1.maxLevel,
    Math.floor(totalXp / SEASON_RULES_V1.xpPerLevel) + 1,
  );
  const capped = totalXp >= (SEASON_RULES_V1.maxLevel - 1) * SEASON_RULES_V1.xpPerLevel;
  const rank = [...SEASON_RULES_V1.rankThresholds]
    .reverse()
    .find((item) => totalXp >= item.xp)!.rank;
  return {
    totalXp,
    level,
    currentXp: capped ? SEASON_RULES_V1.xpPerLevel : totalXp % SEASON_RULES_V1.xpPerLevel,
    neededXp: SEASON_RULES_V1.xpPerLevel,
    rank,
    capped,
  };
}

