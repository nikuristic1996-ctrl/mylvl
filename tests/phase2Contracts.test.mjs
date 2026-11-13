import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { finishAward, prepareAward } from "../supabase/functions/_shared/awardService.ts";
import { normalizeActivityType } from "../supabase/functions/_shared/gameEngine.ts";

const migration = await readFile(new URL("../supabase/migrations/20261113011810_phase_2_secure_progression.sql", import.meta.url), "utf8");
const edge = await readFile(new URL("../supabase/functions/award-activity/index.ts", import.meta.url), "utf8");

test("the server recomputes the award from the reserved activity, not client EXP", () => {
  const payload = prepareAward({
    duplicate: false,
    activity_id: "activity-id",
    status: "pending",
    xp: 999999,
    daily_metric_before: 0,
    activity: {
      activity_type: "Running",
      source: "screenshot",
      validation_status: "user_confirmed",
      duration_minutes: 30,
      distance_km: 5,
      metadata: { demo: false },
    },
  }, "request-id");
  assert.equal(payload.xp, 500);
  assert.equal(payload.status, "eligible");
  assert.equal(payload.ruleVersion, "1.0.0");
});

test("demo, manual, and unconfirmed activity submissions cannot receive EXP", () => {
  const demo = prepareAward({
    duplicate: false, activity_id: "a", status: "pending", xp: 50,
    activity: { activity_type: "Running", source: "screenshot", validation_status: "user_confirmed", distance_km: 5, duration_minutes: 30, metadata: { demo: true } },
  }, "demo-key");
  assert.equal(demo.xp, 0);
  assert.equal(demo.validationStatus, "demo");

  const manual = prepareAward({
    duplicate: false, activity_id: "b", status: "pending", xp: 50,
    activity: { activity_type: "Running", source: "manual", validation_status: "unverified", distance_km: 5, duration_minutes: 30, metadata: {} },
  }, "manual-key");
  assert.equal(manual.xp, 0);
  assert.equal(manual.status, "ineligible");
});

test("a duplicate reservation cannot create another EXP transaction", async () => {
  let finalized = false;
  const duplicate = { duplicate: true, activity_id: "a", status: "awarded", xp: 500 };
  const response = await finishAward(duplicate, null, async () => { finalized = true; });
  assert.equal(finalized, false);
  assert.equal(response, duplicate);
});

test("a retried pending reservation can finish after a transient server failure", () => {
  const payload = prepareAward({
    duplicate: true, activity_id: "a", status: "pending", xp: 0,
    daily_metric_before: 0,
    activity: {
      activity_type: "Running", source: "screenshot", validation_status: "user_confirmed",
      duration_minutes: 30, distance_km: 5, metadata: { demo: false },
    },
  }, "same-idempotency-key");
  assert.equal(payload.xp, 500);
  assert.equal(payload.requestKey, "same-idempotency-key");
});

test("migration is additive, preserves current EXP, and does not invent a season", () => {
  assert.match(migration, /^-- Phase 2:[\s\S]*?begin;/i);
  assert.match(migration, /commit;\s*$/i);
  assert.doesNotMatch(migration, /\b(drop\s+table|truncate\s+|delete\s+from)\b/i);
  assert.match(migration, /set current_level = public\.permanent_level_for_exp\(total_exp\)/i);
  assert.doesNotMatch(migration, /insert\s+into\s+public\.seasons/i);
  assert.match(migration, /ends_at = starts_at \+ interval '2016 hours'/i);
});

test("database award writes are locked, idempotent, and committed atomically", () => {
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /unique \(user_id, request_key\)/i);
  assert.match(migration, /experience_transactions_one_activity_award_idx/i);
  assert.match(migration, /create trigger on_experience_transaction_created/i);
  assert.match(migration, /insert into public\.experience_transactions/i);
  assert.match(migration, /update public\.activity_award_attempts/i);
  assert.match(migration, /activity_type text not null check \(activity_type in \([\s\S]*?'pullups'[\s\S]*?\)\)/i);
  assert.match(migration, /v_type text := public\.canonical_activity_type\(p_activity ->> 'activity_type'\)/i);
  assert.match(migration, /where user_id = p_user_id and local_date = v_local_date\s+and activity_type = v_type/i);
});

test("database canonicalization runs before duplicate handling and daily locking", () => {
  assert.equal(normalizeActivityType("Running"), "running");
  assert.equal(normalizeActivityType("running"), "running");
  assert.equal(normalizeActivityType("RUNNING"), "running");
  assert.equal(normalizeActivityType("unsupported"), null);
  const reserve = migration.slice(migration.indexOf("create or replace function public.reserve_activity_award"));
  assert.ok(reserve.indexOf("canonical_activity_type") < reserve.indexOf("Same request key"));
  assert.ok(reserve.indexOf("canonical_activity_type") < reserve.indexOf("pg_advisory_xact_lock"));
});

test("clients cannot insert EXP or call award RPCs; only the server role can", () => {
  assert.match(migration, /revoke insert, update, delete on public\.experience_transactions, public\.user_progress/i);
  assert.match(migration, /revoke all on function public\.finalize_activity_award[\s\S]*?from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.finalize_activity_award[\s\S]*?to service_role/i);
  assert.match(edge, /auth\.getUser\(token\)/);
  assert.match(edge, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(edge, /incoming\.xp/);
});

test("activity, transaction, permanent progress, and seasonal progress update through one DB transaction", () => {
  assert.match(migration, /create or replace function public\.apply_experience_transaction\(\)/i);
  assert.match(migration, /insert into public\.season_progress/i);
  assert.match(migration, /insert into public\.permanent_level_history/i);
  assert.match(migration, /on conflict \(user_id, season_id\) do update/i);
});

test("season scheduling uses fixed UTC durations and rejects overlapping windows", () => {
  assert.match(migration, /interval '2016 hours'/i);
  assert.match(migration, /tstzrange\(s\.starts_at, s\.ends_at, '\[\)'\)\s*&&\s*tstzrange\(new\.starts_at, new\.ends_at, '\[\)'\)/i);
  assert.match(migration, /starts_at <= now\(\) and now\(\) < ends_at/i);
});

