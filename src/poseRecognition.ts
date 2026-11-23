export type ExerciseKind = "pushups" | "squats";
export type CameraPerspective = "side" | "front" | "diagonal-front";
export type PoseLandmark = { x: number; y: number; visibility?: number; presence?: number };
export type PoseFrame = { landmarks: PoseLandmark[]; width: number; height: number; timestampMs: number };
export type RepPhase = "find-start" | "ready" | "lowering" | "bottom" | "rising";
export type PoseFrameResult = {
  usable: boolean;
  phase: RepPhase;
  repetitions: number;
  confidence: number;
  warning?: string;
};
export type PoseAnalysis = {
  repetitions: number;
  confidence: number;
  totalFrames: number;
  usableFrames: number;
  usableRatio: number;
  durationSeconds: number;
  partialRep: boolean;
  warnings: string[];
  validationReady: boolean;
};

const POSE_VERSION = "mylvl-pose-v1";
const INDEX = {
  leftShoulder: 11, rightShoulder: 12, leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16, leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26, leftAnkle: 27, rightAnkle: 28,
} as const;
const VISIBILITY_MIN = 0.55;
const MIN_REP_MS = 500;
const FRONT_PUSHUP_MIN_REP_MS = 100;
const FRONT_PUSHUP_START_BODY_DROP = 0.035;
const FRONT_PUSHUP_BOTTOM_BODY_DROP = 0.06;
const FRONT_PUSHUP_CLEAR_BODY_DROP = 0.10;
const MAX_REP_MS = 12_000;
const REQUIRED_CONFIDENCE = 0.60;

function visibility(landmark: PoseLandmark | undefined) {
  if (!landmark || !Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) return 0;
  return Math.max(0, Math.min(1, landmark.visibility ?? landmark.presence ?? 0));
}

function point(landmarks: PoseLandmark[], index: number, width: number, height: number) {
  const item = landmarks[index];
  return item ? { x: item.x * width, y: item.y * height } : null;
}

export function jointAngle(a: {x:number;y:number}, b: {x:number;y:number}, c: {x:number;y:number}) {
  const first = Math.atan2(a.y - b.y, a.x - b.x);
  const second = Math.atan2(c.y - b.y, c.x - b.x);
  const delta = Math.abs(first - second);
  return Math.min(delta, Math.PI * 2 - delta) * 180 / Math.PI;
}

type Side = "left" | "right";
function bestSide(landmarks: PoseLandmark[], kind: ExerciseKind): Side {
  const indices = kind === "pushups"
    ? [[INDEX.leftShoulder, INDEX.leftElbow, INDEX.leftWrist, INDEX.leftHip, INDEX.leftKnee, INDEX.leftAnkle], [INDEX.rightShoulder, INDEX.rightElbow, INDEX.rightWrist, INDEX.rightHip, INDEX.rightKnee, INDEX.rightAnkle]]
    : [[INDEX.leftShoulder, INDEX.leftHip, INDEX.leftKnee, INDEX.leftAnkle], [INDEX.rightShoulder, INDEX.rightHip, INDEX.rightKnee, INDEX.rightAnkle]];
  const score = (list: number[]) => list.reduce((sum, index) => sum + visibility(landmarks[index]), 0) / list.length;
  return score(indices[0]) >= score(indices[1]) ? "left" : "right";
}

function median(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.floor(ordered.length / 2)];
}

export class ExerciseRepRecognizer {
  readonly modelVersion = POSE_VERSION;
  private readonly kind: ExerciseKind;
  private readonly perspective: CameraPerspective;
  private phase: RepPhase = "find-start";
  private reps = 0;
  private totalFrames = 0;
  private usableFrames = 0;
  private confidenceSum = 0;
  private warningCounts = new Map<string, number>();
  private angleWindow: number[] = [];
  private cycleStartMs = 0;
  private cycleStartAngle = 0;
  private cycleStartBodyY: number | null = null;
  private cycleBodyTravel = 0;
  private frontTopAngle: number | null = null;
  private frontTopNoseY: number | null = null;
  private frontTopShoulderY: number | null = null;
  private frontActiveAnchor: "nose" | "shoulder" | null = null;
  private frontPeakBodyDrop = 0;
  private frontHighestAngle = 0;
  private lowestAngle = 180;
  private firstTimestamp = 0;
  private sawPartial = false;

  constructor(kind: ExerciseKind, perspective: CameraPerspective = "side") { this.kind = kind; this.perspective = perspective; }

  get repetitions() { return this.reps; }
  get currentPhase() { return this.phase; }

  process(frame: PoseFrame): PoseFrameResult {
    this.totalFrames++;
    if (!this.firstTimestamp) this.firstTimestamp = frame.timestampMs;
    if (!frame.width || !frame.height || frame.landmarks.length < 29) return this.invalidFrame(this.kind === "pushups" && this.perspective !== "side" ? "Pose landmarks are incomplete for the front view." : "Keep your full body in the camera view.");
    if (this.kind === "pushups" && this.perspective !== "side") return this.processFrontPushup(frame);
    const side = bestSide(frame.landmarks, this.kind);
    const shoulder = INDEX[`${side}Shoulder` as "leftShoulder" | "rightShoulder"];
    const hip = INDEX[`${side}Hip` as "leftHip" | "rightHip"];
    const knee = INDEX[`${side}Knee` as "leftKnee" | "rightKnee"];
    const ankle = INDEX[`${side}Ankle` as "leftAnkle" | "rightAnkle"];
    const required = this.kind === "pushups"
      ? [shoulder, INDEX[`${side}Elbow` as "leftElbow" | "rightElbow"], INDEX[`${side}Wrist` as "leftWrist" | "rightWrist"], hip, knee, ankle]
      : [shoulder, hip, knee, ankle];
    const visibilities = required.map((index) => visibility(frame.landmarks[index]));
    if (visibilities.some((score) => score < VISIBILITY_MIN)) return this.invalidFrame("Improve lighting and keep your full body visible.");
    const pixelPoints = required.map((index) => frame.landmarks[index]);
    if (pixelPoints.some((item) => item.x < 0.01 || item.x > 0.99 || item.y < 0.01 || item.y > 0.99)) {
      return this.invalidFrame("Move farther back so your whole body fits in frame.");
    }
    const shoulderPoint = point(frame.landmarks, shoulder, frame.width, frame.height)!;
    const hipPoint = point(frame.landmarks, hip, frame.width, frame.height)!;
    const kneePoint = point(frame.landmarks, knee, frame.width, frame.height)!;
    const anklePoint = point(frame.landmarks, ankle, frame.width, frame.height)!;
    let angle: number;
    let alignment = 180;
    if (this.kind === "pushups") {
      const elbowIndex = INDEX[`${side}Elbow` as "leftElbow" | "rightElbow"];
      const wristIndex = INDEX[`${side}Wrist` as "leftWrist" | "rightWrist"];
      const elbowPoint = point(frame.landmarks, elbowIndex, frame.width, frame.height)!;
      const wristPoint = point(frame.landmarks, wristIndex, frame.width, frame.height)!;
      angle = jointAngle(shoulderPoint, elbowPoint, wristPoint);
      alignment = jointAngle(shoulderPoint, hipPoint, anklePoint);
      if (this.perspective === "side" && alignment < 135) return this.invalidFrame("Keep shoulders, hips and ankles in a steady line.");
    } else {
      angle = jointAngle(hipPoint, kneePoint, anklePoint);
    }
    this.angleWindow.push(angle);
    if (this.angleWindow.length > 3) this.angleWindow.shift();
    const filtered = median(this.angleWindow);
    this.usableFrames++;
    this.confidenceSum += visibilities.reduce((sum, score) => sum + score, 0) / visibilities.length;
    this.updatePhase(filtered, this.perspective === "diagonal-front" ? 180 : alignment, frame.timestampMs);
    return { usable: true, phase: this.phase, repetitions: this.reps, confidence: this.currentConfidence() };
  }

  private processFrontPushup(frame: PoseFrame): PoseFrameResult {
    const noseIndex = 0;
    const nose = frame.landmarks[noseIndex];
    if (visibility(nose) < VISIBILITY_MIN || nose.x < 0.01 || nose.x > 0.99 || nose.y < 0.01 || nose.y > 0.99) {
      return this.invalidFrame("Keep your head and shoulders visible in the front view.");
    }
    const arms = [
      { side: "left", shoulder: INDEX.leftShoulder, elbow: INDEX.leftElbow, wrist: INDEX.leftWrist },
      { side: "right", shoulder: INDEX.rightShoulder, elbow: INDEX.rightElbow, wrist: INDEX.rightWrist },
    ].map((arm) => {
      const indices = [arm.shoulder, arm.elbow, arm.wrist];
      const points = indices.map((index) => frame.landmarks[index]);
      const scores = indices.map((index) => visibility(frame.landmarks[index]));
      const inFrame = points.every((item) => item.x >= 0.01 && item.x <= 0.99 && item.y >= 0.01 && item.y <= 0.99);
      const usable = inFrame && scores.every((score) => score >= VISIBILITY_MIN);
      const angle = usable ? jointAngle(
        point(frame.landmarks, arm.shoulder, frame.width, frame.height)!,
        point(frame.landmarks, arm.elbow, frame.width, frame.height)!,
        point(frame.landmarks, arm.wrist, frame.width, frame.height)!,
      ) : null;
      return { ...arm, indices, scores, usable, angle, score: scores.reduce((sum, value) => sum + value, 0) / scores.length };
    }).filter((arm) => arm.usable && arm.angle !== null);
    if (!arms.length) return this.invalidFrame("Keep at least one complete arm, from shoulder to hand, in the camera view.");
    const ordered = [...arms].sort((a, b) => b.score - a.score);
    const selected = ordered.length > 1 && Math.abs(ordered[0].angle! - ordered[1].angle!) <= 40 ? ordered : [ordered[0]];
    const angle = selected.reduce((sum, arm) => sum + arm.angle!, 0) / selected.length;
    const leftShoulder = frame.landmarks[INDEX.leftShoulder];
    const rightShoulder = frame.landmarks[INDEX.rightShoulder];
    const visibleShoulders = [leftShoulder, rightShoulder].filter((item) => visibility(item) >= VISIBILITY_MIN);
    const shoulderCenterY = visibleShoulders.length
      ? visibleShoulders.reduce((sum, item) => sum + item.y * frame.height, 0) / visibleShoulders.length
      : NaN;
    const shoulderWidth = visibility(leftShoulder) >= VISIBILITY_MIN && visibility(rightShoulder) >= VISIBILITY_MIN
      ? Math.hypot((leftShoulder.x - rightShoulder.x) * frame.width, (leftShoulder.y - rightShoulder.y) * frame.height)
      : frame.width * 0.2;
    const safeShoulderWidth = Math.max(1, shoulderWidth);
    const noseY = nose.y * frame.height / safeShoulderWidth;
    const shoulderY = shoulderCenterY / safeShoulderWidth;
    const bodyY = (noseY + shoulderY) / 2;
    if (![noseY, shoulderY, bodyY].every(Number.isFinite)) return this.invalidFrame("Keep your face and shoulders centered in the frame.");
    const confidenceLandmarks = [...new Set([noseIndex, ...selected.flatMap((arm) => arm.indices),
      ...[INDEX.leftShoulder, INDEX.rightShoulder].filter((index) => visibility(frame.landmarks[index]) >= VISIBILITY_MIN)])];
    const scores = confidenceLandmarks.map((index) => visibility(frame.landmarks[index]));
    const points = confidenceLandmarks.map((index) => frame.landmarks[index]);
    if (points.some((item) => item.x < 0.01 || item.x > 0.99 || item.y < 0.01 || item.y > 0.99)) {
      return this.invalidFrame("Keep your head, shoulders, arms and hands inside the guide.");
    }
    this.angleWindow.push(angle);
    if (this.angleWindow.length > 3) this.angleWindow.shift();
    const smoothed = median(this.angleWindow);
    // Fast lowering or rising can cross an entire phase between inference frames.
    // Preserve a strong real angle change instead of letting the 3-frame median erase it.
    const filtered = Math.abs(angle - smoothed) >= 14 ? angle : smoothed;
    this.usableFrames++;
    this.confidenceSum += scores.reduce((sum, score) => sum + score, 0) / scores.length;
    this.updatePhase(filtered, 180, frame.timestampMs, bodyY, noseY, shoulderY);
    return { usable: true, phase: this.phase, repetitions: this.reps, confidence: this.currentConfidence() };
  }

  finish(recordingDurationSeconds: number): PoseAnalysis {
    const usableRatio = this.totalFrames ? this.usableFrames / this.totalFrames : 0;
    const confidence = this.currentConfidence();
    const warnings = [...this.warningCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([warning]) => warning);
    if (this.sawPartial) warnings.push("A partial repetition was not counted.");
    if (this.reps === 0) warnings.push("No complete repetitions were detected. Check your camera angle and repeat the set.");
    if (usableRatio < 0.65) warnings.push("Too many frames missed the required body landmarks.");
    if (confidence < REQUIRED_CONFIDENCE) warnings.push("Pose confidence was below the required threshold.");
    return {
      repetitions: this.reps, confidence, totalFrames: this.totalFrames, usableFrames: this.usableFrames,
      usableRatio, durationSeconds: Math.max(0, Math.min(120, recordingDurationSeconds)),
      partialRep: this.sawPartial, warnings, validationReady: this.reps > 0 && this.totalFrames >= 12 && usableRatio >= 0.65 && confidence >= REQUIRED_CONFIDENCE,
    };
  }

  private invalidFrame(warning: string): PoseFrameResult {
    this.warningCounts.set(warning, (this.warningCounts.get(warning) ?? 0) + 1);
    if (this.phase !== "find-start" && this.phase !== "ready") this.sawPartial = true;
    return { usable: false, phase: this.phase, repetitions: this.reps, confidence: this.currentConfidence(), warning };
  }

  private recordBodyTravel(bodyY?: number) {
    if (bodyY !== undefined && this.cycleStartBodyY !== null) {
      this.cycleBodyTravel = Math.max(this.cycleBodyTravel, Math.abs(bodyY - this.cycleStartBodyY));
    }
  }

  private currentConfidence() {
    if (!this.totalFrames || !this.usableFrames) return 0;
    const meanVisibility = this.confidenceSum / this.usableFrames;
    return Math.max(0, Math.min(1, meanVisibility * (this.usableFrames / this.totalFrames)));
  }

  private updateFrontPushupPhase(angle: number, now: number, bodyY: number, noseY: number, shoulderY: number) {
    if (this.phase === "find-start") {
      this.frontTopNoseY = this.frontTopNoseY === null ? noseY : Math.min(this.frontTopNoseY, noseY);
      this.frontTopShoulderY = this.frontTopShoulderY === null ? shoulderY : Math.min(this.frontTopShoulderY, shoulderY);
      this.frontTopAngle = Math.max(this.frontTopAngle ?? 0, angle);
      // Establish separate top references for the head and shoulder line.
      if (angle >= 65) {
        this.phase = "ready";
        this.cycleStartBodyY = bodyY;
      }
      return;
    }

    if ((this.phase === "lowering" || this.phase === "bottom" || this.phase === "rising") && now - this.cycleStartMs > MAX_REP_MS) {
      this.phase = "find-start";
      this.frontTopNoseY = noseY;
      this.frontTopShoulderY = shoulderY;
      this.frontActiveAnchor = null;
      this.frontTopAngle = angle;
      this.sawPartial = true;
      return;
    }

    const noseTopY = this.frontTopNoseY ?? noseY;
    const shoulderTopY = this.frontTopShoulderY ?? shoulderY;
    const noseDrop = Math.max(0, noseY - noseTopY);
    const shoulderDrop = Math.max(0, shoulderY - shoulderTopY);
    const observedDrop = Math.max(noseDrop, shoulderDrop);

    if (this.phase === "ready") {
      // Update each reference independently only when that landmark moves higher.
      if (noseY < noseTopY) this.frontTopNoseY = noseY;
      if (shoulderY < shoulderTopY) this.frontTopShoulderY = shoulderY;
      const angleDrop = (this.frontTopAngle ?? angle) - angle;
      if (observedDrop >= FRONT_PUSHUP_START_BODY_DROP || angleDrop >= 12) {
        // Follow whichever landmark gives the clearest signal for this set.
        this.frontActiveAnchor = noseDrop >= shoulderDrop ? "nose" : "shoulder";
        const activeDrop = this.frontActiveAnchor === "nose" ? noseDrop : shoulderDrop;
        this.phase = "lowering";
        this.cycleStartMs = now;
        this.cycleStartBodyY = bodyY;
        this.frontPeakBodyDrop = activeDrop;
        this.cycleStartAngle = angle;
        this.lowestAngle = angle;
        this.frontHighestAngle = angle;
      }
      return;
    }

    const bodyDrop = this.frontActiveAnchor === "nose" ? noseDrop : shoulderDrop;
    this.frontPeakBodyDrop = Math.max(this.frontPeakBodyDrop, bodyDrop);
    this.lowestAngle = Math.min(this.lowestAngle, angle);
    this.frontHighestAngle = Math.max(this.frontHighestAngle, angle);
    const returningFromPeak = bodyDrop <= this.frontPeakBodyDrop - FRONT_PUSHUP_START_BODY_DROP;

    if (this.phase === "lowering") {
      // A fast rep can have no sampled frame in the middle of the rising
      // phase. Count the completed return immediately when the next observed
      // frame is already back at the top.
      if (bodyDrop <= FRONT_PUSHUP_START_BODY_DROP &&
          this.frontPeakBodyDrop >= FRONT_PUSHUP_BOTTOM_BODY_DROP) {
        this.completeFrontPushup(now, noseY, shoulderY, angle);
      } else if (this.frontPeakBodyDrop >= FRONT_PUSHUP_BOTTOM_BODY_DROP) {
        this.phase = "bottom";
      } else if (returningFromPeak) {
        this.phase = "rising";
      }
    } else if (this.phase === "bottom") {
      if (bodyDrop <= FRONT_PUSHUP_START_BODY_DROP &&
          this.frontPeakBodyDrop >= FRONT_PUSHUP_BOTTOM_BODY_DROP) {
        this.completeFrontPushup(now, noseY, shoulderY, angle);
      } else if (returningFromPeak) {
        this.phase = "rising";
      }
    } else if (this.phase === "rising") {
      // If the user reverses direction before returning to the top, resume
      // tracking the descent instead of accepting a partial movement.
      if (bodyDrop >= this.frontPeakBodyDrop - FRONT_PUSHUP_START_BODY_DROP / 2) {
        this.phase = "bottom";
      } else if (bodyDrop <= FRONT_PUSHUP_START_BODY_DROP) {
        this.completeFrontPushup(now, noseY, shoulderY, angle);
      }
    }
  }

  private completeFrontPushup(now: number, noseY: number, shoulderY: number, angle: number) {
    const cycleDuration = now - this.cycleStartMs;
    const armRange = this.frontHighestAngle - this.lowestAngle;
    const visibleMovement = armRange >= 6 || this.frontPeakBodyDrop >= FRONT_PUSHUP_CLEAR_BODY_DROP;
    if (cycleDuration >= FRONT_PUSHUP_MIN_REP_MS &&
        this.frontPeakBodyDrop >= FRONT_PUSHUP_BOTTOM_BODY_DROP &&
        visibleMovement) {
      this.reps++;
    } else {
      this.sawPartial = true;
    }
    this.phase = "ready";
    this.frontTopNoseY = noseY;
    this.frontTopShoulderY = shoulderY;
    this.frontActiveAnchor = null;
    this.frontTopAngle = angle;
    this.frontPeakBodyDrop = 0;
  }

  private updatePhase(angle: number, alignment: number, now: number, bodyY?: number, noseY?: number, shoulderY?: number) {
    const frontPushup = this.kind === "pushups" && this.perspective !== "side";
    if (frontPushup && bodyY !== undefined && noseY !== undefined && shoulderY !== undefined) {
      this.updateFrontPushupPhase(angle, now, bodyY, noseY, shoulderY);
      return;
    }
    if ((this.phase === "lowering" || this.phase === "bottom" || this.phase === "rising") && now - this.cycleStartMs > MAX_REP_MS) {
      this.phase = "find-start";
      this.sawPartial = true;
    }
    switch (this.phase) {
      case "find-start":
        if (angle >= 155 && alignment >= 135) { this.phase = "ready"; this.cycleStartBodyY = bodyY ?? null; }
        break;
      case "ready":
        if (angle <= 137) {
          this.phase = "lowering";
          this.cycleBodyTravel = 0;
          this.cycleStartBodyY = bodyY ?? this.cycleStartBodyY;
          this.cycleStartMs = now;
          this.cycleStartAngle = 155;
          this.lowestAngle = angle;
        }
        break;
      case "lowering":
        this.recordBodyTravel(bodyY);
        this.lowestAngle = Math.min(this.lowestAngle, angle);
        if (angle <= (this.kind === "pushups" ? 95 : 100)) this.phase = "bottom";
        else if (angle >= 155) this.phase = "ready";
        break;
      case "bottom":
        this.recordBodyTravel(bodyY);
        this.lowestAngle = Math.min(this.lowestAngle, angle);
        if (angle >= (this.kind === "pushups" ? 117 : 122)) this.phase = "rising";
        break;
      case "rising":
        this.recordBodyTravel(bodyY);
        this.lowestAngle = Math.min(this.lowestAngle, angle);
        if (angle <= (this.kind === "pushups" ? 95 : 100)) this.phase = "bottom";
        else if (angle >= 155 && alignment >= 135) {
          const cycleDuration = now - this.cycleStartMs;
          const movementRange = this.cycleStartAngle - this.lowestAngle;
          if (cycleDuration >= MIN_REP_MS && movementRange >= 50) this.reps++;
          else this.sawPartial = true;
          this.phase = "ready";
        }
        break;
    }
  }
}

export const poseModelVersion = "pose_landmarker_lite_float16_v1";
export const POSE_RECOGNITION_VERSION = POSE_VERSION;
export const MIN_POSE_CONFIDENCE = REQUIRED_CONFIDENCE;

