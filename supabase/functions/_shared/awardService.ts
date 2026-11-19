import {
  calculateActivityXp,
  normalizeActivityType,
  type ActivityType,
  type ActivityXpResult,
} from "./gameEngine.ts";
import { parseCameraExerciseSubmission } from "./cameraValidation.ts";

export type ReservedActivity = {
  duplicate: boolean;
  attempt_id?: string;
  activity_id: string;
  status: string;
  xp: number;
  daily_metric_before?: number;
  activity?: Record<string, unknown>;
};

export type FinalizePayload = {
  requestKey: string;
  status: ActivityXpResult["status"];
  xp: number;
  validationStatus: "user_confirmed" | "provider_verified" | "pose_validated" | "pending_review" | "rejected" | "demo" | "unverified";
  ruleVersion: string | null;
  metadata: Record<string, unknown>;
};

function numeric(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Recomputes EXP from the server-reserved activity snapshot; ignores any client XP value. */
export function prepareAward(
  reservation: ReservedActivity,
  requestKey: string,
): FinalizePayload | null {
  // A retry may receive an existing pending reservation after the Edge Function
  // failed between reserve and finalize. Recompute it so the transaction can finish.
  if (reservation.status !== "pending" || !reservation.activity) return null;
  const row = reservation.activity;
  const type: ActivityType | null = normalizeActivityType(row.activity_type);
  const source = row.source === "screenshot" ? "screenshot"
    : row.source === "manual" ? "manual"
    : row.source === "camera" ? "camera" : null;
  const demo = Boolean((row.metadata as Record<string, unknown> | undefined)?.demo);
  if (!type || !source) {
    return {
      requestKey, status: "ineligible", xp: 0, validationStatus: "rejected",
      ruleVersion: null, metadata: { reason: "unsupported_activity_or_source" },
    };
  }

  const cameraMeta = (row.metadata as Record<string, unknown> | undefined)?.exercise_validation;
  const cameraSubmission = source === "camera" ? parseCameraExerciseSubmission(cameraMeta) : null;
  if (source === "camera" && ((type !== "pushups" && type !== "squats") || !cameraSubmission
    || !cameraSubmission.ok || cameraSubmission.value.sessionId !== requestKey
    || row.source_key !== requestKey || row.validation_status !== "pose_validated")) {
    return { requestKey, status: "ineligible", xp: 0, validationStatus: "rejected", ruleVersion: null,
      metadata: { reason: "invalid_camera_validation_metadata" } };
  }
  const camera = source === "camera" && cameraSubmission?.ok ? cameraSubmission.value : null;

  const result = calculateActivityXp({
    type,
    source,
    demo,
    screenshotConfirmed: row.validation_status === "user_confirmed",
    recordedSession: source === "camera",
    exerciseValidation: camera ? { detectedAmount: camera.detectedReps, userEstimate: camera.reportedReps,
      confidence: camera.confidence, minimumConfidence: 0.75 } : undefined,
    dailyMetricBefore: numeric(reservation.daily_metric_before) ?? 0,
    dailyStepsReconciled: false,
    metrics: {
      distanceKm: numeric(row.distance_km),
      steps: numeric(row.steps),
      distanceMeters: numeric(row.distance_meters),
      durationMinutes: numeric(row.duration_minutes),
      repetitions: numeric(row.repetitions),
      holdSeconds: numeric(row.hold_seconds),
      activeCalories: numeric(row.active_calories),
    },
  });
  const status = result.xp > 0 ? result.status : result.status === "requires-review" ? result.status : "ineligible";
  const validationStatus = demo
    ? "demo"
    : status === "eligible"
      ? result.validation === "user-confirmed" ? "user_confirmed" : result.validation === "pose-validated" ? "pose_validated" : "provider_verified"
      : status === "requires-review" ? "pending_review" : "rejected";
  return {
    requestKey,
    status,
    xp: result.xp,
    validationStatus,
    ruleVersion: result.xp > 0 ? result.ruleVersion : null,
    metadata: {
      metric: result.metric,
      measured_amount: result.measuredAmount,
      validation: result.validation,
      reason: result.reason ?? null,
      warnings: result.warnings,
      validation_method: demo ? "demo_extraction" : result.validation === "user-confirmed"
        ? "screenshot_user_confirmation" : result.validation === "pose-validated" ? "local_pose_landmarks" : "not_verified",
      ...(camera ? { exercise_validation: camera } : {}),
    },
  };
}

export async function finishAward(
  reservation: ReservedActivity,
  payload: FinalizePayload | null,
  finalize: (input: FinalizePayload) => Promise<unknown>,
) {
  if (!payload) return reservation;
  return await finalize(payload);
}

