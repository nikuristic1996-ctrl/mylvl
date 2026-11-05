export type ActivityType =
  | "Walking"
  | "Running"
  | "Strength"
  | "Bodyweight"
  | "Yoga"
  | "Pilates"
  | "Cycling"
  | "Swimming"
  | "Other";
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
};
export type Avatar = {
  name: string;
  hair: string;
  skin: string;
  outfit: string;
};
export type AppData = { activities: Activity[]; avatar: Avatar };

export const XP_RULES: Record<
  ActivityType,
  { base: number; perMinute: number }
> = {
  Walking: { base: 12, perMinute: 1.1 },
  Running: { base: 25, perMinute: 2.1 },
  Strength: { base: 22, perMinute: 1.7 },
  Bodyweight: { base: 16, perMinute: 1.5 },
  Yoga: { base: 14, perMinute: 1.2 },
  Pilates: { base: 16, perMinute: 1.3 },
  Cycling: { base: 20, perMinute: 1.6 },
  Swimming: { base: 24, perMinute: 1.9 },
  Other: { base: 10, perMinute: 1 },
};
export function calculateXp(type: ActivityType, duration: number) {
  const rule = XP_RULES[type];
  return Math.round(rule.base + Math.max(0, duration) * rule.perMinute);
}
export function levelForXp(xp: number) {
  let level = 1,
    remaining = Math.max(0, xp),
    needed = 250;
  while (remaining >= needed) {
    remaining -= needed;
    level += 1;
    needed = Math.round(250 + level * 85);
  }
  return { level, current: remaining, needed, total: xp };
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
