import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261123190000_nose_counter_pushup_self_report.sql", import.meta.url), "utf8");

test("Nose Counter migration only adds its source and restricted reservation function", () => {
  assert.match(migration, /'manual','screenshot','apple_health','health_connect','garmin','strava','camera','nose_counter'/i);
  assert.match(migration, /create or replace function public\.reserve_nose_counter_award/i);
  assert.match(migration, /revoke all on function public\.reserve_nose_counter_award[\s\S]*from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.reserve_nose_counter_award[\s\S]*to service_role/i);
  assert.doesNotMatch(migration, /\b(drop table|truncate|delete from|drop column|drop policy)\b/i);
});

test("Nose Counter SQL validates source, confirmation, exercise and bounds", () => {
  assert.match(migration, /nose_counter_confirmed/);
  assert.match(migration, /v_type <> 'pushups'/);
  assert.match(migration, /v_repetitions not between 1 and 500/);
  assert.match(migration, /v_duration < 1 or v_duration > 180/);
  assert.match(migration, /10800/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /sum\(metric_amount\)/);
  assert.match(migration, /insert into public\.activity_award_attempts/);
  assert.match(migration, /on conflict do nothing/);
});
