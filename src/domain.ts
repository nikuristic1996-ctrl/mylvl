import { permanentProgressForXp } from "./gameEngine";

export type ActivityType =
  | "Walking"
  | "Running"
  | "Strength"
  | "Bodyweight"
  | "Yoga"
  | "Pilates"
  | "Cycling"
  | "Swimming"
  | "Other"
  | "Push-ups"
  | "Squats"
  | "Sit-ups"
  | "Plank"
  | "Pull-ups";
export type ActivityValidationStatus =
  | "unverified"
  | "user_confirmed"
  | "provider_verified"
  | "pose_validated"
  | "pending_review"
  | "rejected"
  | "demo"
  | "legacy_unreviewed";
export type Activity = {
  id: string;
  type: ActivityType;
  date: string;
  duration: number;
  distance?: number;
  steps?: number;
  calories?: number;
  reps?: number;
  notes?: string;
  xp: number;
  source: "manual" | "screenshot" | "provider";
  sourceKey?: string;
  validationStatus?: ActivityValidationStatus;
  demo?: boolean;
};
export type Avatar = {
  name: string;
  hair: string;
  skin: string;
  outfit: string;
};
export type AppData = { activities: Activity[]; avatar: Avatar };

export function levelForXp(xp: number) {
  const progress = permanentProgressForXp(xp);
  return { ...progress, total: progress.totalXp };
}
export const starterActivities: Activity[] = [
  {
    id: "seed-1",
    type: "Running",
    date: new Date().toISOString(),
    duration: 32,
    distance: 5.2,
    calories: 412,
    xp: 92,
    source: "manual",
    notes: "Easy morning miles",
  },
  {
    id: "seed-2",
    type: "Strength",
    date: new Date(Date.now() - 86400000).toISOString(),
    duration: 45,
    calories: 280,
    xp: 99,
    source: "manual",
    notes: "Upper body",
  },
  {
    id: "seed-3",
    type: "Walking",
    date: new Date(Date.now() - 2 * 86400000).toISOString(),
    duration: 28,
    distance: 2.1,
    steps: 3280,
    xp: 43,
    source: "manual",
  },
  {
    id: "seed-4",
    type: "Yoga",
    date: new Date(Date.now() - 3 * 86400000).toISOString(),
    duration: 25,
    xp: 44,
    source: "manual",
    notes: "Evening reset",
  },
];
const KEY = "mylvl-v1";
export function loadData(): AppData {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return JSON.parse(saved) as AppData;
  } catch {
    /* Use local starter state if storage is unavailable. */
  }
  return {
    activities: starterActivities,
    avatar: {
      name: "Alex",
      hair: "#b7f56a",
      skin: "#d89b73",
      outfit: "#a893ff",
    },
  };
}
export function saveData(data: AppData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* App remains usable for this session. */
  }
}
export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

