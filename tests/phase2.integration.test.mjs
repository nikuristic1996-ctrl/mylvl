import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { permanentProgressForXp, seasonProgressForXp } from "../src/gameEngine.ts";

const enabled = process.env.PHASE2_INTEGRATION === "1";
const apiUrl = process.env.SUPABASE_URL ?? "";
const anonKey = process.env.SUPABASE_ANON_KEY ?? "";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const functionUrl = process.env.AWARD_FUNCTION_URL ?? `${apiUrl}/functions/v1/award-activity`;
const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
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

async function award(user, { type = "Running", distance = 5, requestKey = randomUUID(), sourceKey = randomUUID() } = {}) {
  const response = await fetch(functionUrl, {
    method: "POST",
    headers: {
      apikey: anonKey,
      authorization: `Bearer ${user.token}`,
      "content-type": "application/json",
      origin: "http://localhost:5173",
    },
    body: JSON.stringify({
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
    }),
  });
  return { response, body: await response.json() };
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
  const responses = await Promise.all([
    award(user, { type: "Running", distance: 20 }),
    award(user, { type: "running", distance: 21 }),
    award(user, { type: "RUNNING", distance: 22 }),
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

