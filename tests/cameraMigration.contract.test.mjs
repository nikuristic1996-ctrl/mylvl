import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261118110000_phase_6_camera_exercise.sql", import.meta.url), "utf8");

test("camera migration only expands the existing activity source constraint", () => {
  assert.match(migration, /alter table public\.activities\s+drop constraint if exists activities_source_check/i);
  assert.match(migration, /'manual','screenshot','apple_health','health_connect','garmin','strava','camera'/i);
  assert.doesNotMatch(migration, /\b(drop table|truncate|delete from|drop column|drop policy)\b/i);
});

test("camera reservation is idempotent, serialized by user day and type, and server-only", () => {
  assert.match(migration, /where user_id = p_user_id and request_key = p_request_key/i);
  assert.match(migration, /source='camera' and source_key=v_session::text/i);
  assert.match(migration, /pg_advisory_xact_lock/i);
  assert.match(migration, /revoke all on function public\.reserve_camera_exercise_award[\s\S]*from public,anon,authenticated/i);
  assert.match(migration, /grant execute on function public\.reserve_camera_exercise_award[\s\S]*to service_role/i);
});

test("camera reservation enforces exercise limits and recent timestamps", () => {
  assert.match(migration, /v_type not in \('pushups','squats'\)/i);
  assert.match(migration, /v_confidence < 0\.75/i);
  assert.match(migration, /abs\(v_reported - v_detected\)::numeric \/ greatest\(1,v_detected\) > 0\.10/i);
  assert.match(migration, /abs\(extract\(epoch from \(now\(\) - v_date\)\)\) > 900/i);
});

