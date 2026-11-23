import type { Activity, ActivityType, AppData, Avatar, ActivityValidationStatus } from "./domain";
import { seasonProgressForXp, type SeasonProgress } from "./gameEngine";
import { normalizeProgressionStats, type ProgressionStats } from "./progressionStats";
import { supabase } from "./supabase";

type DatabaseActivity = {
  id: string;
  activity_type: string;
  activity_date: string;
  duration: number;
  duration_minutes: number;
  distance: number | null;
  distance_km: number | null;
  distance_meters: number | null;
  steps: number | null;
  calories: number | null;
  active_calories: number | null;
  repetitions: number | null;
  hold_seconds: number | null;
  notes: string | null;
  source: string;
  source_key: string | null;
  validation_status: ActivityValidationStatus;
  metadata: Record<string, unknown>;
};
type DatabaseTransaction = {
  id: string;
  activity_id: string | null;
  exp_amount: number;
  transaction_type: string;
  created_at: string;
  metadata: Record<string, unknown>;
};
type DatabaseAvatar = Partial<Avatar>;
export type RecentExperienceTransaction = {
  id: string;
  activityId: string | null;
  amount: number;
  type: string;
  createdAt: string;
};
export type SeasonSnapshot = {
  id: string;
  key: string;
  name: string;
  startsAt: string;
  endsAt: string;
  progress: SeasonProgress;
};
export type ArchivedSeasonSnapshot = {
  key: string;
  name: string;
  startsAt: string;
  endsAt: string;
  progress: SeasonProgress;
};
export type ScheduledSeasonSnapshot = { name: string; startsAt: string; endsAt: string };
export type CosmeticRewardSnapshot = {
  key: string; name: string; description: string;
  type: "outfit" | "profile_frame" | "title" | "badge" | "visual_effect";
  milestoneXp: number; owned: boolean; unlockedAt?: string;
};

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

function displayActivityType(type: string): ActivityType {
  const map: Record<string, ActivityType> = {
    walking: "Walking", running: "Running", cycling: "Cycling", swimming: "Swimming",
    strength: "Strength", yoga: "Yoga", pilates: "Pilates", pushups: "Push-ups",
    squats: "Squats", situps: "Sit-ups", plank: "Plank", pullups: "Pull-ups",
  };
  return map[type] ?? type as ActivityType;
}

export async function loadCloudData(userId: string): Promise<{
  data: AppData;
  totalXp: number;
  season: SeasonSnapshot | null;
  seasonHistory: ArchivedSeasonSnapshot[];
  scheduledSeason: ScheduledSeasonSnapshot | null;
  recentTransactions: RecentExperienceTransaction[];
  progressionStats: ProgressionStats;
  cosmeticRewards: CosmeticRewardSnapshot[];
}> {
  const client = requireSupabase();
  const { error: archiveError } = await client.rpc("archive_my_ended_seasons");
  if (archiveError) throw archiveError;
  const now = new Date().toISOString();
  const [profile, activities, transactions, progress, seasonRow, seasonHistoryRows, nextSeasonRow, rewardCatalog, ownedRewards, statsQuery] = await Promise.all([
    client.from("profiles").select("username, avatar_configuration").eq("id", userId).maybeSingle(),
    client.from("activities").select("*").eq("user_id", userId).order("activity_date", { ascending: false }).limit(100),
    client.from("experience_transactions")
      .select("id, activity_id, exp_amount, transaction_type, created_at, metadata")
      .eq("user_id", userId).order("created_at", { ascending: false }).limit(8),
    client.from("user_progress").select("total_exp").eq("user_id", userId).maybeSingle(),
    client.from("seasons").select("id, season_key, name, starts_at, ends_at")
      .lte("starts_at", now).gt("ends_at", now).order("starts_at", { ascending: false }).limit(1).maybeSingle(),
    client.from("season_history").select("season_key, season_name, starts_at, ends_at, season_exp, season_level, season_rank")
      .eq("user_id", userId).order("ends_at", { ascending: false }).limit(8),
    client.from("seasons").select("name, starts_at, ends_at")
      .gt("starts_at", now).order("starts_at", { ascending: true }).limit(1).maybeSingle(),
    client.from("season_reward_catalog").select("reward_key, name, description, reward_type, milestone_exp")
      .eq("active", true).order("milestone_exp", { ascending: true }),
    client.from("user_cosmetic_rewards").select("reward_key, unlocked_at").eq("user_id", userId),
    client.rpc("get_my_progression_stats"),
  ]);
  const error = profile.error ?? activities.error ?? transactions.error ?? progress.error ?? seasonRow.error
    ?? seasonHistoryRows.error ?? nextSeasonRow.error ?? rewardCatalog.error ?? ownedRewards.error ?? statsQuery.error;
  if (error) throw error;

  const currentSeason = seasonRow.data;
  const seasonProgressQuery = currentSeason
    ? await client.from("season_progress").select("season_exp")
        .eq("user_id", userId).eq("season_id", currentSeason.id).maybeSingle()
    : null;
  if (seasonProgressQuery?.error) throw seasonProgressQuery.error;

  const activityRows = (activities.data ?? []) as DatabaseActivity[];
  const transactionRows = (transactions.data ?? []) as DatabaseTransaction[];
  const xpByActivity = new Map<string, number>();
  for (const transaction of transactionRows) {
    if (transaction.activity_id) xpByActivity.set(transaction.activity_id, transaction.exp_amount);
  }
  const avatarConfig = (profile.data?.avatar_configuration ?? {}) as DatabaseAvatar;
  const avatar: Avatar = {
    name: profile.data?.username ?? "Adventurer",
    hair: avatarConfig.hair ?? "#b7f56a",
    skin: avatarConfig.skin ?? "#d89b73",
    outfit: avatarConfig.outfit ?? "#a893ff",
    heightCm: avatarConfig.heightCm,
  };
  const data: AppData = {
    avatar,
    activities: activityRows.map((item) => ({
      id: item.id,
      type: displayActivityType(item.activity_type),
      date: item.activity_date,
      duration: Number(item.duration_minutes ?? item.duration),
      distance: item.distance_km == null ? item.distance ?? undefined : Number(item.distance_km),
      steps: item.steps ?? undefined,
      calories: item.active_calories == null ? item.calories ?? undefined : Number(item.active_calories),
      reps: item.repetitions ?? undefined,
      notes: item.notes ?? undefined,
      xp: xpByActivity.get(item.id) ?? 0,
      source: item.source === "camera" ? "camera" : item.source === "nose_counter" ? "nose_counter" : item.source === "screenshot" ? "screenshot" : item.source === "manual" ? "manual" : "provider",
      sourceKey: item.source_key ?? undefined,
      validationStatus: item.validation_status,
      demo: Boolean(item.metadata?.demo),
    })),
  };
  const season: SeasonSnapshot | null = currentSeason
    ? {
        id: currentSeason.id,
        key: currentSeason.season_key,
        name: currentSeason.name,
        startsAt: currentSeason.starts_at,
        endsAt: currentSeason.ends_at,
        progress: seasonProgressForXp(Number(seasonProgressQuery?.data?.season_exp ?? 0)),
      }
    : null;
  const seasonHistory: ArchivedSeasonSnapshot[] = (seasonHistoryRows.data ?? []).map((item) => ({
    key: item.season_key,
    name: item.season_name,
    startsAt: item.starts_at,
    endsAt: item.ends_at,
    progress: seasonProgressForXp(Number(item.season_exp)),
  }));
  const ownership = new Map((ownedRewards.data ?? []).map((item) => [item.reward_key, item.unlocked_at]));
  const cosmeticRewards: CosmeticRewardSnapshot[] = (rewardCatalog.data ?? []).map((item) => ({
    key: item.reward_key,
    name: item.name,
    description: item.description,
    type: item.reward_type,
    milestoneXp: Number(item.milestone_exp),
    owned: ownership.has(item.reward_key),
    unlockedAt: ownership.get(item.reward_key),
  }));
  return {
    data,
    totalXp: Number(progress.data?.total_exp ?? 0),
    season,
    seasonHistory,
    scheduledSeason: nextSeasonRow.data ? {
      name: nextSeasonRow.data.name,
      startsAt: nextSeasonRow.data.starts_at,
      endsAt: nextSeasonRow.data.ends_at,
    } : null,
    recentTransactions: transactionRows.map((item) => ({
      id: item.id,
      activityId: item.activity_id,
      amount: item.exp_amount,
      type: item.transaction_type,
      createdAt: item.created_at,
    })),
    progressionStats: normalizeProgressionStats(statsQuery.data),
    cosmeticRewards,
  };
}

export async function saveCloudAvatar(userId: string, avatar: Avatar) {
  const { error } = await requireSupabase().from("profiles").update({
    username: avatar.name || "Adventurer",
    avatar_configuration: { hair: avatar.hair, skin: avatar.skin, outfit: avatar.outfit, heightCm: avatar.heightCm },
  }).eq("id", userId);
  if (error) throw error;
}

export async function recordCloudActivity(activity: Activity) {
  const { data, error } = await requireSupabase().functions.invoke("award-activity", {
    body: {
      requestKey: activity.id,
      activity: {
        type: activity.type,
        date: activity.date,
        duration: activity.duration,
        distance: activity.distance,
        distanceMeters: (activity as Activity & { distanceMeters?: number }).distanceMeters,
        steps: activity.steps,
        calories: activity.calories,
        activeCalories: (activity as Activity & { activeCalories?: number }).activeCalories,
        reps: activity.reps,
        holdSeconds: (activity as Activity & { holdSeconds?: number }).holdSeconds,
        notes: activity.notes,
        source: activity.source,
        sourceKey: activity.sourceKey,
        exerciseSession: activity.exerciseSession,
        screenshotConfirmed: activity.validationStatus === "user_confirmed",
        noseCounterConfirmed: activity.source === "nose_counter" && activity.validationStatus === "user_confirmed",
        demo: activity.demo === true,
      },
    },
  });
  if (error) throw error;
  const result = data as {
    activity_id?: string;
    duplicate?: boolean;
    xp?: number;
    status?: string;
  } | null;
  if (!result?.activity_id) throw new Error("Supabase did not return the saved activity.");
  return {
    id: result.activity_id,
    xp: Number(result.xp ?? 0),
    duplicate: Boolean(result.duplicate),
    status: result.status ?? "pending",
  };
}

