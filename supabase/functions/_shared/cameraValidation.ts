import { validateExerciseEstimate, type ExerciseValidation } from "./gameEngine.ts";

export type CameraExerciseSubmission = {
  sessionId: string;
  reportedReps: number;
  detectedReps: number;
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
export const CAMERA_MIN_CONFIDENCE = 0.65;
export const CAMERA_MAX_REPETITIONS = 500;
export const CAMERA_MODEL_VERSION = "pose_landmarker_lite_float16_v1";
export const CAMERA_VALIDATION_VERSION = "mylvl-pose-v1";

export type CameraExerciseParseResult = { ok: true; value: CameraExerciseSubmission } | { ok: false; error: string };

export function parseCameraExerciseSubmission(input: unknown): CameraExerciseParseResult {
  if (!input || typeof input !== "object") return { ok: false, error: "Camera recognition details are required." };
  const item = input as Record<string, unknown>;
  const numeric = (key: string) => typeof item[key] === "number" ? item[key] as number : Number.NaN;
  const value: CameraExerciseSubmission = {
    sessionId: typeof item.sessionId === "string" ? item.sessionId : "",
    reportedReps: numeric("reportedReps"), detectedReps: numeric("detectedReps"), confidence: numeric("confidence"),
    recordingDurationSeconds: numeric("recordingDurationSeconds"), modelVersion: typeof item.modelVersion === "string" ? item.modelVersion : "",
    validationVersion: typeof item.validationVersion === "string" ? item.validationVersion : "",
    usableFrames: numeric("usableFrames"), usableRatio: numeric("usableRatio"),
    deviationPercent: typeof item.deviationPercent === "number" ? item.deviationPercent : null,
  };
  if (!UUID_PATTERN.test(value.sessionId)) return { ok: false, error: "Camera session ID must be a valid UUID." };
  if (![value.reportedReps, value.detectedReps, value.usableFrames].every(Number.isSafeInteger)
    || value.reportedReps < 1 || value.detectedReps < 1 || value.reportedReps > CAMERA_MAX_REPETITIONS || value.detectedReps > CAMERA_MAX_REPETITIONS || value.usableFrames < 12) {
    return { ok: false, error: "Reported and detected repetitions must be positive, bounded whole numbers with enough usable frames." };
  }
  if (!Number.isFinite(value.confidence) || value.confidence < CAMERA_MIN_CONFIDENCE || value.confidence > 1
    || !Number.isFinite(value.usableRatio) || value.usableRatio < 0.65 || value.usableRatio > 1
    || !Number.isFinite(value.recordingDurationSeconds) || value.recordingDurationSeconds < 2 || value.recordingDurationSeconds > CAMERA_MAX_RECORDING_SECONDS) {
    return { ok: false, error: "Camera confidence, usable frames, or recording duration did not meet the required limits." };
  }
  if (value.modelVersion !== CAMERA_MODEL_VERSION || value.validationVersion !== CAMERA_VALIDATION_VERSION) {
    return { ok: false, error: "Camera model or validation version is missing." };
  }
  const validation: ExerciseValidation = { detectedAmount: value.detectedReps, userEstimate: value.reportedReps, confidence: value.confidence, minimumConfidence: CAMERA_MIN_CONFIDENCE };
  const result = validateExerciseEstimate(validation);
  if (result.status !== "accepted") return { ok: false, error: `Exercise count validation failed: ${result.status}.` };
  if (value.deviationPercent !== null && (!Number.isFinite(value.deviationPercent) || Math.abs(value.deviationPercent - (result.deviationPercent ?? 0)) > 0.02)) {
    return { ok: false, error: "The submitted validation difference did not match the server calculation." };
  }
  value.deviationPercent = result.deviationPercent;
  return { ok: true, value };
}

