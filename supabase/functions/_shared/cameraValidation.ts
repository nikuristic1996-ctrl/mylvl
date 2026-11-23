import { validateExerciseEstimate, type ExerciseValidation, type ExerciseValidationResult } from "./gameEngine.ts";

export type CameraExerciseType = "pushups" | "squats" | "situps" | "plank";
export type CameraExerciseMetric = "repetitions" | "hold_seconds";
export type CameraExerciseSubmission = {
  sessionId: string;
  exerciseType: CameraExerciseType;
  metricType: CameraExerciseMetric;
  reportedAmount: number;
  detectedAmount: number;
  reportedReps?: number;
  detectedReps?: number;
  reportedHoldSeconds?: number;
  detectedHoldSeconds?: number;
  confidence: number;
  recordingDurationSeconds: number;
  modelVersion: string;
  validationVersion: string;
  usableFrames: number;
  usableRatio: number;
  deviationPercent: number | null;
};
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CAMERA_MAX_RECORDING_SECONDS = 90;
export const CAMERA_MIN_CONFIDENCE = 0.60;
export const CAMERA_MAX_REPETITIONS = 500;
export const CAMERA_MAX_DEVIATION_PERCENT = 10;
export const CAMERA_MODEL_VERSION = "pose_landmarker_lite_float16_v1";
export const CAMERA_VALIDATION_VERSION = "mylvl-pose-v1";
export type CameraExerciseParseResult = { ok: true; value: CameraExerciseSubmission } | { ok: false; error: string };

export function compareCameraEstimate(input: {
  reportedAmount: number; detectedAmount: number; confidence: number; minimumConfidence?: number;
}): ExerciseValidationResult {
  const validation: ExerciseValidation = {
    detectedAmount: input.detectedAmount,
    userEstimate: input.reportedAmount,
    confidence: input.confidence,
    minimumConfidence: input.minimumConfidence ?? CAMERA_MIN_CONFIDENCE,
    maximumDeviationPercent: CAMERA_MAX_DEVIATION_PERCENT,
  };
  return validateExerciseEstimate(validation);
}

/** Validates the user estimate while preserving the detected value as the only award metric. */
export function parseCameraExerciseSubmission(input: unknown, expectedType?: CameraExerciseType): CameraExerciseParseResult {
  if (!input || typeof input !== "object") return { ok: false, error: "Camera recognition details are required." };
  const item = input as Record<string, unknown>;
  const numeric = (key: string) => typeof item[key] === "number" ? item[key] as number : Number.NaN;
  const exerciseType = (item.exerciseType ?? expectedType) as CameraExerciseType;
  if (!["pushups", "squats", "situps", "plank"].includes(exerciseType) || (expectedType && exerciseType !== expectedType)) {
    return { ok: false, error: "Camera exercise type does not match the selected activity." };
  }
  const metricType: CameraExerciseMetric = exerciseType === "plank" ? "hold_seconds" : "repetitions";
  if (item.metricType !== undefined && item.metricType !== metricType) return { ok: false, error: "The camera metric does not match this exercise." };
  const reportedAmount = exerciseType === "plank" ? numeric("reportedHoldSeconds") : numeric("reportedReps");
  const detectedAmount = exerciseType === "plank" ? numeric("detectedHoldSeconds") : numeric("detectedReps");
  const value: CameraExerciseSubmission = {
    sessionId: typeof item.sessionId === "string" ? item.sessionId : "",
    exerciseType, metricType, reportedAmount, detectedAmount,
    ...(exerciseType === "plank" ? { reportedHoldSeconds: reportedAmount, detectedHoldSeconds: detectedAmount }
      : { reportedReps: reportedAmount, detectedReps: detectedAmount }),
    confidence: numeric("confidence"),
    recordingDurationSeconds: numeric("recordingDurationSeconds"),
    modelVersion: typeof item.modelVersion === "string" ? item.modelVersion : "",
    validationVersion: typeof item.validationVersion === "string" ? item.validationVersion : "",
    usableFrames: numeric("usableFrames"),
    usableRatio: numeric("usableRatio"),
    deviationPercent: typeof item.deviationPercent === "number" ? item.deviationPercent : null,
  };
  if (!UUID_PATTERN.test(value.sessionId)) return { ok: false, error: "Camera session ID must be a valid UUID." };
  const amountIsValid = exerciseType === "plank"
    ? Number.isFinite(reportedAmount) && Number.isFinite(detectedAmount) && reportedAmount > 0 && detectedAmount > 0 && reportedAmount <= CAMERA_MAX_RECORDING_SECONDS && detectedAmount <= CAMERA_MAX_RECORDING_SECONDS
    : Number.isSafeInteger(reportedAmount) && Number.isSafeInteger(detectedAmount) && reportedAmount >= 1 && detectedAmount >= 1 && reportedAmount <= CAMERA_MAX_REPETITIONS && detectedAmount <= CAMERA_MAX_REPETITIONS;
  if (!amountIsValid || !Number.isSafeInteger(value.usableFrames) || value.usableFrames < 12) {
    return { ok: false, error: "The reported and detected values must be valid and enough usable frames are required." };
  }
  if (!Number.isFinite(value.confidence) || value.confidence < CAMERA_MIN_CONFIDENCE || value.confidence > 1
    || !Number.isFinite(value.usableRatio) || value.usableRatio < 0.65 || value.usableRatio > 1
    || !Number.isFinite(value.recordingDurationSeconds) || value.recordingDurationSeconds < 2 || value.recordingDurationSeconds > CAMERA_MAX_RECORDING_SECONDS) {
    return { ok: false, error: "Camera confidence, usable frames, or recording duration did not meet the required limits." };
  }
  if (value.modelVersion !== CAMERA_MODEL_VERSION || value.validationVersion !== CAMERA_VALIDATION_VERSION) {
    return { ok: false, error: "Camera model and validation versions are required." };
  }
  const result = compareCameraEstimate({ reportedAmount, detectedAmount, confidence: value.confidence });
  if (result.status !== "accepted") return { ok: false, error: `Camera estimate validation failed: ${result.status}; the maximum difference is 10%.` };
  if (value.deviationPercent !== null && (!Number.isFinite(value.deviationPercent) || Math.abs(value.deviationPercent - (result.deviationPercent ?? 0)) > 0.02)) {
    return { ok: false, error: "The submitted validation difference did not match the server calculation." };
  }
  value.deviationPercent = result.deviationPercent;
  return { ok: true, value };
}
