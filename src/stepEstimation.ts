import type { Activity } from "./domain";

export type StepEstimate = {
  steps: number | null;
  source: "measured" | "estimated" | null;
  method: "measured" | "cadence" | "personalized" | "pace" | null;
  stepLengthMeters: number | null;
};

// Heuristic reference curve for a 178 cm runner; adjacent points are linearly interpolated.
export const STEP_LENGTH_REFERENCE: ReadonlyArray<{ paceSecondsPerKm: number; meters: number }> = [
  { paceSecondsPerKm: 240, meters: 1.4 }, { paceSecondsPerKm: 300, meters: 1.2 },
  { paceSecondsPerKm: 360, meters: 1.05 }, { paceSecondsPerKm: 420, meters: 0.95 },
  { paceSecondsPerKm: 480, meters: 0.85 }, { paceSecondsPerKm: 540, meters: 0.75 },
];

export function parsePaceSecondsPerKm(raw: string): number | undefined {
  const match = raw.trim().match(/^(\d{1,2}):([0-5]\d)\s*(?:min\s*)?(?:\/\s*(km|mi|mile)|per\s+(km|mi|mile))?$/i);
  if (!match) return undefined;
  const value = Number(match[1]) * 60 + Number(match[2]);
  if (value <= 0) return undefined;
  const unit = (match[3] || match[4] || "km").toLowerCase();
  return unit.startsWith("mi") ? value / 1.609344 : value;
}

function bounded(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }

export function estimatedStepLength(paceSecondsPerKm: number, heightCm?: number): number | undefined {
  // Outside 2:00–30:00 min/km, OCR or input errors are more likely than a useful estimate.
  if (!Number.isFinite(paceSecondsPerKm) || paceSecondsPerKm < 120 || paceSecondsPerKm > 1800) return undefined;
  const points = STEP_LENGTH_REFERENCE;
  let low = points[0], high = points[1];
  if (paceSecondsPerKm >= points.at(-1)!.paceSecondsPerKm) {
    low = points.at(-2)!; high = points.at(-1)!;
  } else if (paceSecondsPerKm <= points[0].paceSecondsPerKm) {
    low = points[0]; high = points[1];
  } else {
    for (let index = 1; index < points.length; index += 1) {
      if (paceSecondsPerKm <= points[index].paceSecondsPerKm) { low = points[index - 1]; high = points[index]; break; }
    }
  }
  const ratio = (paceSecondsPerKm - low.paceSecondsPerKm) / (high.paceSecondsPerKm - low.paceSecondsPerKm);
  const baseline = bounded(low.meters + ratio * (high.meters - low.meters), 0.55, 1.55);
  // Height is only a small adjustment; individual stride mechanics vary substantially.
  const validHeight = heightCm && Number.isFinite(heightCm) && heightCm >= 120 && heightCm <= 220 ? heightCm : undefined;
  const heightAdjustment = validHeight ? bounded(Math.sqrt(validHeight / 178), 0.94, 1.06) : 1;
  return Math.round(bounded(baseline * heightAdjustment, 0.55, 1.55) * 1000) / 1000;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function personalizedStepLength(activities: Activity[]): number | undefined {
  const calibrated = activities.filter((activity) => activity.type === "Running"
    && activity.distance !== undefined && activity.distance > 0 && activity.steps !== undefined && activity.steps > 0
    && (activity.validationStatus === "provider_verified" || /steps source:\s*measured/i.test(activity.notes ?? "")))
    .map((activity) => activity.distance! * 1000 / activity.steps!)
    .filter((length) => Number.isFinite(length) && length >= 0.55 && length <= 1.55);
  if (calibrated.length < 3) return undefined;
  return Math.round(median(calibrated) * 1000) / 1000;
}

export function estimateRunningSteps(input: {
  type: string; distanceKm?: number; pace?: string; heightCm?: number; measuredSteps?: number;
  cadence?: number; cadenceUnit?: "steps/min" | "strides/min"; movingDurationMinutes?: number;
  activities?: Activity[];
}): StepEstimate {
  if (input.type !== "Running") return { steps: null, source: null, method: null, stepLengthMeters: null };
  if (Number.isFinite(input.measuredSteps) && input.measuredSteps! >= 0) {
    return { steps: Math.round(input.measuredSteps!), source: "measured", method: "measured", stepLengthMeters: null };
  }
  if (Number.isFinite(input.cadence) && input.cadence! > 0
    && Number.isFinite(input.movingDurationMinutes) && input.movingDurationMinutes! > 0
    && (input.cadenceUnit === "steps/min" || input.cadenceUnit === "strides/min")) {
    const multiplier = input.cadenceUnit === "strides/min" ? 2 : 1;
    const steps = input.cadence! * multiplier * input.movingDurationMinutes!;
    if (steps <= 200000) return { steps: Math.round(steps), source: "estimated", method: "cadence", stepLengthMeters: null };
  }
  const personal = personalizedStepLength(input.activities ?? []);
  if (personal && Number.isFinite(input.distanceKm) && input.distanceKm! > 0 && input.distanceKm! <= 1000) {
    return { steps: Math.round(input.distanceKm! * 1000 / personal), source: "estimated", method: "personalized", stepLengthMeters: personal };
  }
  const pace = input.pace ? parsePaceSecondsPerKm(input.pace) : undefined;
  const length = pace === undefined ? undefined : estimatedStepLength(pace, input.heightCm);
  if (!length || !Number.isFinite(input.distanceKm) || input.distanceKm! <= 0 || input.distanceKm! > 1000) {
    return { steps: null, source: null, method: null, stepLengthMeters: null };
  }
  return { steps: Math.round(input.distanceKm! * 1000 / length), source: "estimated", method: "pace", stepLengthMeters: length };
}

