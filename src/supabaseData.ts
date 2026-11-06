import type { Activity, ActivityType, AppData, Avatar } from "./domain";
import { supabase } from "./supabase";

type DatabaseActivity = {
  id: string;
  activity_type: ActivityType;
  activity_date: string;
  duration: number;
  distance: number | null;
  steps: number | null;
  calories: number | null;
  repetitions: number | null;
  notes: string | null;
  source: string;
  source_key: string | null;
};

type DatabaseTransaction = { activity_id: string | null; exp_amount: number };
type DatabaseAvatar = Partial<Avatar>;

function requireSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export async function loadCloudData(
  userId: string,
): Promise<{ data: AppData; totalXp: number }> {
  const client = requireSupabase();
  const [profile, activities, transactions, progress] = await Promise.all([
    client
      .from("profiles")
      .select("username, avatar_configuration")
      .eq("id", userId)
      .maybeSingle(),
    client
      .from("activities")
      .select("*")
      .eq("user_id", userId)
      .order("activity_date", { ascending: false }),
    client
      .from("experience_transactions")
      .select("activity_id, exp_amount")
      .eq("user_id", userId)
      .eq("transaction_type", "activity"),
    client
      .from("user_progress")
      .select("total_exp")
      .eq("user_id", userId)
      .maybeSingle(),
  ]);
  const error =
    profile.error ?? activities.error ?? transactions.error ?? progress.error;
  if (error) throw error;

  const xpByActivity = new Map<string, number>();
  for (const transaction of (transactions.data ??
    []) as DatabaseTransaction[]) {
    if (transaction.activity_id)
      xpByActivity.set(transaction.activity_id, transaction.exp_amount);
  }
  const avatarConfig = (profile.data?.avatar_configuration ??
    {}) as DatabaseAvatar;
  const avatar: Avatar = {
    name: profile.data?.username ?? "Adventurer",
    hair: avatarConfig.hair ?? "#b7f56a",
    skin: avatarConfig.skin ?? "#d89b73",
    outfit: avatarConfig.outfit ?? "#a893ff",
  };
  return {
    data: {
      avatar,
      activities: ((activities.data ?? []) as DatabaseActivity[]).map(
        (item) => ({
          id: item.id,
          type: item.activity_type,
          date: item.activity_date,
          duration: item.duration,
          distance: item.distance ?? undefined,
          steps: item.steps ?? undefined,
          calories: item.calories ?? undefined,
          reps: item.repetitions ?? undefined,
          notes: item.notes ?? undefined,
          xp: xpByActivity.get(item.id) ?? 0,
          source:
            item.source === "screenshot"
              ? "screenshot"
              : item.source === "manual"
                ? "manual"
                : "provider",
          sourceKey: item.source_key ?? undefined,
        }),
      ),
    },
    totalXp: Number(progress.data?.total_exp ?? 0),
  };
}

export async function saveCloudAvatar(userId: string, avatar: Avatar) {
  const { error } = await requireSupabase()
    .from("profiles")
    .update({
      username: avatar.name || "Adventurer",
      avatar_configuration: {
        hair: avatar.hair,
        skin: avatar.skin,
        outfit: avatar.outfit,
      },
    })
    .eq("id", userId);
  if (error) throw error;
}

export async function recordCloudActivity(activity: Activity) {
  const { data, error } = await requireSupabase().rpc("record_activity", {
    p_activity: {
      activity_type: activity.type,
      activity_date: activity.date,
      duration: activity.duration,
      distance: activity.distance ?? null,
      steps: activity.steps ?? null,
      calories: activity.calories ?? null,
      repetitions: activity.reps ?? null,
      notes: activity.notes ?? null,
      source: activity.source,
      source_key: activity.sourceKey ?? null,
    },
  });
  if (error) throw error;
  const result = (Array.isArray(data) ? data[0] : data) as {
    activity_id: string;
    exp_amount: number;
    duplicate: boolean;
  } | null;
  if (!result?.activity_id)
    throw new Error("Supabase did not return the saved activity.");
  return {
    id: result.activity_id,
    xp: result.exp_amount,
    duplicate: result.duplicate,
  };
}
