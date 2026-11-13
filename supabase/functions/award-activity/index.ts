// deno-lint-ignore no-import-prefix -- Supabase Edge Runtime resolves npm: imports natively.
import { createClient } from "npm:@supabase/supabase-js@2";
import { finishAward, prepareAward, type ReservedActivity } from "../_shared/awardService.ts";
import { normalizeActivityType } from "../_shared/gameEngine.ts";

import { corsHeaders, isOriginAllowed } from "../_shared/cors.ts";
const corsSettings = {
  allowedOrigins: Deno.env.get("ALLOWED_ORIGINS") ?? "",
  allowLocalhost: Deno.env.get("ALLOW_LOCALHOST_ORIGINS") !== "false",
  vercelPreviewProject: Deno.env.get("VERCEL_PREVIEW_PROJECT_SLUG") ?? "mylvl",
  vercelPreviewTeam: Deno.env.get("VERCEL_PREVIEW_TEAM_SLUG") ?? "nikuristic1996-5844s-projects",
};
const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin, corsSettings), "Content-Type": "application/json" },
  });

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("Origin");
  if (request.method === "OPTIONS") {
    if (!isOriginAllowed(origin, corsSettings)) return new Response(null, { status: 403, headers: { "Vary": "Origin" } });
    return new Response(null, { status: 204, headers: corsHeaders(origin, corsSettings) });
  }
  if (!isOriginAllowed(origin, corsSettings)) return new Response(JSON.stringify({ error: "Origin is not allowed." }), {
    status: 403,
    headers: { ...corsHeaders(origin, corsSettings), "Content-Type": "application/json" },
  });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const authorization = request.headers.get("Authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!token) return json({ error: "Sign in is required." }, 401, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const publishableKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !publishableKey || !serviceRoleKey) {
    return json({ error: "Secure award service is not configured." }, 503, origin);
  }

  const userClient = createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const adminClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const { data: authData, error: authError } = await userClient.auth.getUser(token);
    if (authError || !authData.user) return json({ error: "Your session is invalid or expired." }, 401, origin);

    const body = await request.json();
    const requestKey = typeof body?.requestKey === "string" ? body.requestKey : "";
    const incoming = body?.activity;
    if (!requestKey || !incoming || typeof incoming !== "object") {
      return json({ error: "An idempotency key and activity are required." }, 400, origin);
    }
    const activityType = normalizeActivityType(incoming.type);
    if (!activityType) return json({ error: "Unknown or unsupported activity type." }, 400, origin);

    // Whitelist client fields. Any client-submitted XP, validation status, or level is ignored.
    const activity = {
      activity_type: activityType,
      activity_date: incoming.date,
      duration_minutes: incoming.duration,
      distance_km: incoming.distance,
      distance_meters: incoming.distanceMeters,
      steps: incoming.steps,
      calories: incoming.calories,
      active_calories: incoming.activeCalories,
      repetitions: incoming.repetitions ?? incoming.reps,
      hold_seconds: incoming.holdSeconds,
      notes: incoming.notes,
      source: incoming.source,
      source_key: incoming.sourceKey,
      screenshot_confirmed: incoming.source === "screenshot" && incoming.screenshotConfirmed === true,
      demo: incoming.demo === true,
    };
    if (activity.source === "screenshot") {
      const date = new Date(String(activity.activity_date ?? ""));
      const duration = Number(activity.duration_minutes);
      const distance = Number(activity.distance_km);
      if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 120_000 || date.getTime() < Date.UTC(2000, 0, 1)) {
        return json({ error: "Enter a valid activity date and start time that is not in the future." }, 400, origin);
      }
      if (!Number.isFinite(duration) || duration <= 0 || duration > 1440) {
        return json({ error: "Activity duration must be between 1 minute and 24 hours." }, 400, origin);
      }
      const requiresDistance = activity.activity_type === "Running" || activity.activity_type === "Cycling" || activity.activity_type === "Swimming";
      if ((requiresDistance && (!Number.isFinite(distance) || distance <= 0)) || (Number.isFinite(distance) && distance > 1000)) {
        return json({ error: "Activity distance must be greater than 0 and no more than 1,000 km." }, 400, origin);
      }
    }
    const { data: rawReservation, error: reserveError } = await adminClient.rpc("reserve_screenshot_activity_award", {
      p_user_id: authData.user.id,
      p_request_key: requestKey,
      p_activity: activity,
    });
    if (reserveError) {
      console.error("Activity reservation failed", reserveError.code);
      return json({ error: "Could not reserve this activity safely." }, 500, origin);
    }
    const reservation = (Array.isArray(rawReservation) ? rawReservation[0] : rawReservation) as ReservedActivity;
    if (!reservation) return json({ error: "The database did not return an activity reservation." }, 500, origin);
    if (reservation.status !== "pending") {
      return json(reservation, 200, origin);
    }

    const prepared = prepareAward(reservation, requestKey);
    const finalized = await finishAward(reservation, prepared, async (result) => {
      const { data, error } = await adminClient.rpc("finalize_activity_award", {
        p_user_id: authData.user.id,
        p_request_key: result.requestKey,
        p_result_status: result.status,
        p_exp_amount: result.xp,
        p_validation_status: result.validationStatus,
        p_rule_version: result.ruleVersion,
        p_result_metadata: result.metadata,
      });
      if (error) throw error;
      return Array.isArray(data) ? data[0] : data;
    });
    return json(finalized, 200, origin);
  } catch (error) {
    console.error("Award processing failed", error instanceof Error ? error.message : "unknown error");
    return json({ error: "Could not finish processing this activity. You can safely retry." }, 500, origin);
  }
});

