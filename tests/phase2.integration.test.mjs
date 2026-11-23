import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test, { after, before } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { permanentProgressForXp, seasonProgressForXp } from "../src/gameEngine.ts";

const enabled = process.env.PHASE2_INTEGRATION === "1";
const apiUrl = process.env.SUPABASE_URL ?? "";
const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const functionUrl = process.env.AWARD_FUNCTION_URL ?? `${apiUrl}/functions/v1/award-activity`;
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
if (enabled) {
  assert.ok(localHosts.has(new URL(apiUrl).hostname) && new URL(apiUrl).port === "54321", "Expected a disposable Supabase API on loopback port 54321.");
  assert.ok(localHosts.has(new URL(functionUrl).hostname), "Refusing to send test awards to a remote handler.");
}
const admin = enabled && apiUrl && serviceKey
  ? createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;
const users = [];
let activeSeasonId;

test("integration setup is restricted to a disposable local Supabase instance", {
  skip: !enabled,
}, async () => {
  assert.ok(apiUrl && anonKey && serviceKey, "Set local SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.");
  assert.ok(localHosts.has(new URL(apiUrl).hostname), "Refusing to run integration tests against a remote database.");
  assert.ok(apiUrl.includes("54321"), "Expected the default local Supabase API port 54321.");
  const start = new Date(Date.now() - 60 * 60 * 1000);
  const end = new Date(start.getTime() + 84 * 24 * 60 * 60 * 1000);
  const { data, error } = await admin.from("seasons").insert({
    season_key: `phase2-test-${randomUUID()}`,
    name: "Local integration season",
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
  }).select("id").single();
  assert.ifError(error);
  activeSeasonId = data.id;
});

after(async () => {
  if (!enabled || !admin) return;
  for (const user of users) await admin.auth.admin.deleteUser(user.id);
  if (activeSeasonId) await admin.from("seasons").delete().eq("id", activeSeasonId);
});

async function createSignedInUser() {
  const email = `phase2-${randomUUID()}@example.test`;
  const password = `Local-${randomUUID()}-Aa1!`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  assert.ifError(createError);
  users.push(created.user);
  const client = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  return { id: created.user.id, client, token: signedIn.session.access_token };
}

async function submitAward(user, payload, endpoint = functionUrl) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${user.token}`,
      "content-type": "application/json",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify(payload),
  });
  return { response, body: await response.json() };
}

async function award(user, { type = "Running", distance = 5, requestKey = randomUUID(), sourceKey = randomUUID() } = {}) {
  return submitAward(user, {
    requestKey,
    activity: {
      type,
      date: new Date().toISOString(),
      duration: 90,
      distance,
      source: "screenshot",
      sourceKey,
      screenshotConfirmed: true,
      demo: false,
    },
  });
}

test("duplicate requests persist one EXP transaction", { skip: !enabled }, async () => {
  const user = await createSignedInUser();
  const requestKey = randomUUID();
  const sourceKey = randomUUID();
  const [first, concurrentRetry] = await Promise.all([
    award(user, { requestKey, sourceKey }),
    award(user, { requestKey, sourceKey }),
  ]);
  assert.equal(first.response.status, 200);
  assert.equal(concurrentRetry.response.status, 200);
  const retry = await award(user, { requestKey, sourceKey });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.body.xp, 500);
  const { data, error } = await admin.from("experience_transactions")
    .select("id, exp_amount").eq("user_id", user.id).eq("transaction_type", "activity");
  assert.ifError(error);
  assert.equal(data.length, 1);
});

test("concurrent Running casing variants share the same daily cap", { skip: !enabled }, async () => {
  const user = await createSignedInUser();
  // Separate workouts for the screenshot duplicate guard, with the original 60 km total.
  const responses = await Promise.all([
    award(user, { type: "Running", distance: 19 }),
    award(user, { type: "running", distance: 20 }),
    award(user, { type: "RUNNING", distance: 21 }),
  ]);
  assert.ok(responses.every((item) => item.response.status === 200));
  const { data, error } = await admin.from("experience_transactions")
    .select("exp_amount").eq("user_id", user.id).eq("transaction_type", "activity");
  assert.ifError(error);
  assert.equal(data.reduce((total, item) => total + item.exp_amount, 0), 4500);
});

test("one award updates permanent and seasonal progression consistently", { skip: !enabled }, async () => {
  const user = await createSignedInUser();
  const { response, body } = await award(user, { distance: 5 });
  assert.equal(response.status, 200);
  assert.equal(body.xp, 500);
  const { data: permanent, error: progressError } = await user.client.from("user_progress")
    .select("total_exp, current_level").eq("user_id", user.id).single();
  assert.ifError(progressError);
  assert.equal(permanent.total_exp, 500);
  assert.equal(permanent.current_level, permanentProgressForXp(500).level);
  const { data: seasonal, error: seasonError } = await user.client.from("season_progress")
    .select("season_exp, season_level, season_rank").eq("user_id", user.id).single();
  assert.ifError(seasonError);
  const expected = seasonProgressForXp(500);
  assert.equal(seasonal.season_exp, 500);
  assert.equal(seasonal.season_level, expected.level);
  assert.equal(seasonal.season_rank, expected.rank);
});

test("RLS hides another user's private progression and clients cannot modify EXP", { skip: !enabled }, async () => {
  const owner = await createSignedInUser();
  const other = await createSignedInUser();
  const { data: hidden, error: readError } = await owner.client.from("user_progress")
    .select("user_id, total_exp").eq("user_id", other.id);
  assert.ifError(readError);
  assert.deepEqual(hidden, []);
  const { error: writeError } = await owner.client.from("user_progress")
    .update({ total_exp: 999999 }).eq("user_id", owner.id);
  assert.ok(writeError, "Client-side progression mutation must be rejected.");
});

test("CORS preflight allows local development and rejects an unrelated origin", { skip: !enabled }, async () => {
  const allowed = await fetch(functionUrl, { method: "OPTIONS", headers: { origin: "http://localhost:5173" } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
  const denied = await fetch(functionUrl, { method: "OPTIONS", headers: { origin: "https://attacker.invalid" } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
});

test("deployed Function accepts this Vercel project's preview host without a wildcard", { skip: !enabled }, async () => {
  const previewOrigin = "https://mylvl-git-phase2test-nikuristic1996-5844s-projects.vercel.app";
  const allowed = await fetch(functionUrl, { method: "OPTIONS", headers: { origin: previewOrigin } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), previewOrigin);
  const unrelated = await fetch(functionUrl, {
    method: "OPTIONS",
    headers: { origin: "https://someone-else-git-main-nikuristic1996-5844s-projects.vercel.app" },
  });
  assert.equal(unrelated.status, 403);
});

test("unknown or unsupported activity types are rejected before saving", { skip: !enabled }, async () => {
  const user = await createSignedInUser();
  const result = await award(user, { type: "Other" });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /unsupported activity type/i);
  const { data, error } = await admin.from("activities").select("id").eq("user_id", user.id);
  assert.ifError(error);
  assert.deepEqual(data, []);
});

function cameraWorkout(exerciseType, sessionId = randomUUID()) {
  const plank = exerciseType === "plank";
  const metric = plank
    ? { reportedHoldSeconds: 30, detectedHoldSeconds: 30 }
    : { reportedReps: 10, detectedReps: 10 };
  return {
    requestKey: sessionId,
    activity: {
      type: plank ? "Plank" : "Sit-ups",
      date: new Date().toISOString(),
      duration: 1,
      source: "camera",
      sourceKey: sessionId,
      ...(plank ? { holdSeconds: 30 } : { reps: 10 }),
      exerciseSession: {
        sessionId,
        exerciseType,
        metricType: plank ? "hold_seconds" : "repetitions",
        ...metric,
        confidence: 0.95,
        usableFrames: 120,
        usableRatio: 0.95,
        recordingDurationSeconds: 35,
        modelVersion: "pose_landmarker_lite_float16_v1",
        validationVersion: "mylvl-pose-v1",
        deviationPercent: 0,
      },
    },
  };
}

async function assertCameraAwards(user, expected) {
  const [activities, attempts, transactions, permanent, seasonal] = await Promise.all([
    admin.from("activities").select("id, request_key, source, source_key, validation_status, repetitions, hold_seconds").eq("user_id", user.id),
    admin.from("activity_award_attempts").select("request_key, activity_id, transaction_id, status, result_xp, finalized_at").eq("user_id", user.id),
    admin.from("experience_transactions").select("id, activity_id, exp_amount, transaction_type, season_id").eq("user_id", user.id),
    user.client.from("user_progress").select("total_exp").eq("user_id", user.id).single(),
    user.client.from("season_progress").select("season_exp").eq("user_id", user.id).eq("season_id", activeSeasonId).single(),
  ]);
  for (const result of [activities, attempts, transactions, permanent, seasonal]) assert.ifError(result.error);
  for (const result of [activities, attempts, transactions]) assert.equal(result.data.length, expected.length);
  for (const { session, xp, activityId } of expected) {
    const activity = activities.data.find((row) => row.request_key === session.requestKey);
    assert.ok(activity);
    assert.equal(activity.id, activityId);
    assert.equal(activity.source, "camera");
    assert.equal(activity.source_key, session.requestKey);
    assert.equal(activity.validation_status, "pose_validated");
    assert.equal(activity.repetitions, session.activity.reps ?? null);
    assert.equal(activity.hold_seconds, session.activity.holdSeconds ?? null);

    const attempt = attempts.data.find((row) => row.request_key === session.requestKey);
    assert.ok(attempt);
    assert.equal(attempt.activity_id, activity.id);
    assert.equal(attempt.status, "awarded");
    assert.equal(attempt.result_xp, xp);
    assert.ok(attempt.finalized_at);

    const transaction = transactions.data.find((row) => row.activity_id === activity.id);
    assert.ok(transaction);
    assert.equal(transaction.id, attempt.transaction_id);
    assert.equal(transaction.transaction_type, "activity");
    assert.equal(transaction.exp_amount, xp);
    assert.equal(transaction.season_id, activeSeasonId);
  }
  const total = expected.reduce((sum, award) => sum + award.xp, 0);
  assert.equal(permanent.data.total_exp, total);
  assert.equal(seasonal.data.season_exp, total);
}

async function loseResponse(user, session) {
  let upstream;
  let upstreamError;
  const proxy = createServer(async (request, response) => {
    try {
      // Let the award finish, then drop the downstream connection before returning any headers.
      const body = await Array.fromAsync(request);
      const result = await fetch(functionUrl, {
        method: "POST",
        headers: {
          apikey: request.headers.apikey,
          authorization: request.headers.authorization,
          "content-type": request.headers["content-type"],
          origin: request.headers.origin,
        },
        body: Buffer.concat(body),
      });
      upstream = { response: result, body: await result.json() };
    } catch (error) {
      upstreamError = error;
    } finally {
      response.destroy();
    }
  });
  await new Promise((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  try {
    await assert.rejects(submitAward(user, session, `http://127.0.0.1:${proxy.address().port}`), /fetch failed/);
    assert.ifError(upstreamError);
    assert.equal(upstream.response.status, 200, JSON.stringify(upstream.body));
    assert.equal(upstream.body.duplicate, false);
    assert.equal(upstream.body.status, "awarded");
    return upstream.body;
  } finally {
    await new Promise((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()));
  }
}

for (const [exerciseType, xp] of [["situps", 20], ["plank", 18]]) {
  test(`${exerciseType}: parallel identical HTTP requests finalize exactly one award`, { skip: !enabled }, async () => {
    const user = await createSignedInUser();
    const session = cameraWorkout(exerciseType);
    const results = await Promise.all(Array.from({ length: 4 }, () => submitAward(user, session)));
    for (const { response, body } of results) {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.status, "awarded");
      assert.equal(body.xp, xp);
    }
    assert.equal(results.filter(({ body }) => body.duplicate === false).length, 1);
    const activityId = results[0].body.activity_id;
    assert.ok(activityId);
    assert.ok(results.every(({ body }) => body.activity_id === activityId));
    await assertCameraAwards(user, [{ session, xp, activityId }]);
  });

  test(`${exerciseType}: retry after a dropped response returns the original award`, { skip: !enabled }, async () => {
    const user = await createSignedInUser();
    const session = cameraWorkout(exerciseType);
    const lost = await loseResponse(user, session);
    const expected = [{ session, xp, activityId: lost.activity_id }];
    await assertCameraAwards(user, expected);
    const retry = await submitAward(user, session);
    assert.equal(retry.response.status, 200, JSON.stringify(retry.body));
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.status, "awarded");
    assert.equal(retry.body.activity_id, lost.activity_id);
    assert.equal(retry.body.xp, xp);
    await assertCameraAwards(user, expected);
  });

  test(`${exerciseType}: separate session IDs each finalize their own award`, { skip: !enabled }, async () => {
    const user = await createSignedInUser();
    const sessions = [cameraWorkout(exerciseType), cameraWorkout(exerciseType)];
    const results = await Promise.all(sessions.map((session) => submitAward(user, session)));
    for (const { response, body } of results) {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.status, "awarded");
      assert.equal(body.duplicate, false);
      assert.equal(body.xp, xp);
    }
    assert.notEqual(results[0].body.activity_id, results[1].body.activity_id);
    await assertCameraAwards(user, sessions.map((session, i) => ({ session, xp, activityId: results[i].body.activity_id })));
  });
}

test("camera requests with mismatched IDs are rejected without creating an award", { skip: !enabled }, async () => {
  const user = await createSignedInUser();
  const session = cameraWorkout("situps");
  const result = await submitAward(user, { ...session, requestKey: randomUUID() });
  assert.equal(result.response.status, 400);
  assert.match(result.body.error, /keys must match/i);
  for (const table of ["activities", "activity_award_attempts", "experience_transactions", "season_progress"]) {
    const { data, error } = await admin.from(table).select("user_id").eq("user_id", user.id);
    assert.ifError(error);
    assert.deepEqual(data, []);
  }
  const { data, error } = await user.client.from("user_progress").select("total_exp").eq("user_id", user.id).single();
  assert.ifError(error);
  assert.equal(data.total_exp, 0);
});
