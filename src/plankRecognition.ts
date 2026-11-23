import {
  CAMERA_MAX_RECORDING_SECONDS, CAMERA_MIN_CONFIDENCE, CAMERA_MIN_RECORDING_SECONDS,
  CAMERA_MIN_USABLE_FRAMES, CAMERA_MIN_USABLE_RATIO, meetsCameraRecordingMinimums,
} from "../supabase/functions/_shared/cameraValidation.ts";
import { jointAngle, type PoseFrame, type PoseLandmark } from "./poseRecognition.ts";

const MIN_VISIBILITY = 0.55;
export const MAX_PLANK_SAMPLE_GAP_MS = 200;
const MAX_BODY_TILT_DEGREES = 25;
const MIN_BODY_LINE_ANGLE = 155;
const MIN_KNEE_ANGLE = 145;
const FOREARM_ANGLE_RANGE: [number, number] = [45, 140];

export type PlankFrameResult = {
  valid: boolean;
  validSeconds: number;
  confidence: number;
  warning?: string;
};
export type PlankAnalysis = {
  validSeconds: number;
  recordingSeconds: number;
  invalidSeconds: number;
  confidence: number;
  totalFrames: number;
  usableFrames: number;
  usableRatio: number;
  warnings: string[];
  validationReady: boolean;
};

const LEFT_SIDE = [11, 13, 15, 23, 25, 27];
const RIGHT_SIDE = [12, 14, 16, 24, 26, 28];

function visibility(landmark: PoseLandmark | undefined) {
  if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) return 0;
  return Math.max(0, Math.min(1, landmark.visibility ?? landmark.presence ?? 0));
}
function pixel(landmark: PoseLandmark, frame: PoseFrame) {
  return { x: landmark.x * frame.width, y: landmark.y * frame.height };
}

/** Timestamp-based side-view forearm-plank detector. It never counts frame totals. */
export class PlankHoldRecognizer {
  private totalFrames = 0;
  private validFrames = 0;
  private confidenceSum = 0;
  private validMilliseconds = 0;
  private lastValidAt: number | null = null;
  private warningCounts = new Map<string, number>();

  get validSeconds() { return this.validMilliseconds / 1000; }

  process(frame: PoseFrame): PlankFrameResult {
    this.totalFrames++;
    if (!Number.isFinite(frame.timestampMs)
      || (this.lastValidAt !== null && frame.timestampMs <= this.lastValidAt)) {
      return this.invalid("Camera frames arrived out of order.");
    }
    if (!frame.width || !frame.height || frame.landmarks.length < 29) return this.invalid("Keep the whole body in view from the side.");
    const left = LEFT_SIDE.map((i) => frame.landmarks[i]);
    const right = RIGHT_SIDE.map((i) => frame.landmarks[i]);
    const leftScores = left.map(visibility);
    const rightScores = right.map(visibility);
    const useRight = Math.min(...rightScores) > Math.min(...leftScores);
    const required = useRight ? right : left;
    const scores = useRight ? rightScores : leftScores;
    if (scores.some((score) => score < MIN_VISIBILITY)) return this.invalid("Keep shoulder, elbow, hip, knee and ankle visible.");
    if (required.some((item) => item.x < 0.01 || item.x > 0.99 || item.y < 0.01 || item.y > 0.99)) {
      return this.invalid("Move the camera back until your full body fits in frame.");
    }
    const [shoulder, elbow, wrist, hip, knee, ankle] = required.map((item) => pixel(item, frame));
    const bodyLine = jointAngle(shoulder, hip, ankle);
    const kneeAngle = jointAngle(hip, knee, ankle);
    const forearmAngle = jointAngle(shoulder, elbow, wrist);
    const bodyTilt = Math.atan2(Math.abs(shoulder.y - ankle.y), Math.abs(shoulder.x - ankle.x)) * 180 / Math.PI;
    const valid = bodyTilt <= MAX_BODY_TILT_DEGREES && elbow.y > shoulder.y
      && bodyLine >= MIN_BODY_LINE_ANGLE && kneeAngle >= MIN_KNEE_ANGLE
      && forearmAngle >= FOREARM_ANGLE_RANGE[0] && forearmAngle <= FOREARM_ANGLE_RANGE[1];
    if (!valid) return this.invalid("Align shoulder, hip, knee and ankle; keep your forearm under the shoulder.");
    const meanConfidence = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    this.validFrames++;
    this.confidenceSum += meanConfidence;
    if (this.lastValidAt !== null) {
      const elapsed = frame.timestampMs - this.lastValidAt;
      // A lost frame or suspended tab breaks continuity. Credit only observed,
      // non-overlapping intervals with a strict per-sample bound.
      if (elapsed > 0 && elapsed <= MAX_PLANK_SAMPLE_GAP_MS) {
        this.validMilliseconds += elapsed;
      }
    }
    this.lastValidAt = frame.timestampMs;
    return { valid: true, validSeconds: this.validSeconds, confidence: this.currentConfidence() };
  }

  missingFrame(): PlankFrameResult {
    this.totalFrames++;
    return this.invalid("No reliable pose was detected.");
  }

  finish(recordingSeconds: number): PlankAnalysis {
    const total = Math.max(0, Math.min(CAMERA_MAX_RECORDING_SECONDS, Number.isFinite(recordingSeconds) ? recordingSeconds : 0));
    const validSeconds = Math.min(total, this.validSeconds);
    const usableRatio = this.totalFrames ? this.validFrames / this.totalFrames : 0;
    const confidence = this.currentConfidence();
    const warnings = [...this.warningCounts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,3).map(([warning])=>warning);
    if (validSeconds < 10) warnings.push("At least 10 validated seconds are needed for the first EXP interval.");
    if (usableRatio < CAMERA_MIN_USABLE_RATIO || confidence < CAMERA_MIN_CONFIDENCE) {
      warnings.push("Tracking was interrupted too often to validate this hold.");
    }
    if (this.validFrames < CAMERA_MIN_USABLE_FRAMES) warnings.push("Too few usable frames were captured.");
    if (recordingSeconds < CAMERA_MIN_RECORDING_SECONDS) warnings.push("Record for at least two seconds.");
    return {
      validSeconds, recordingSeconds: total, invalidSeconds: Math.max(0,total-validSeconds),
      confidence, totalFrames: this.totalFrames, usableFrames: this.validFrames, usableRatio, warnings,
      validationReady: validSeconds > 0 && meetsCameraRecordingMinimums({
        usableFrames: this.validFrames, usableRatio, confidence, recordingDurationSeconds: recordingSeconds,
      }),
    };
  }

  private invalid(warning: string): PlankFrameResult {
    this.lastValidAt = null;
    this.warningCounts.set(warning,(this.warningCounts.get(warning)??0)+1);
    return { valid: false, validSeconds: this.validSeconds, confidence: this.currentConfidence(), warning };
  }
  private currentConfidence() {
    return this.validFrames ? Math.max(0,Math.min(1,this.confidenceSum/this.validFrames*(this.validFrames/Math.max(1,this.totalFrames)))) : 0;
  }
}
