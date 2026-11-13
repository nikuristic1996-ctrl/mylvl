import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const duplicateGuard = await readFile(new URL("../supabase/migrations/20261113150000_screenshot_duplicate_guard.sql", import.meta.url), "utf8");
const cleanup = await readFile(new URL("../supabase/migrations/20261113143730_remove_phase2_smoke_cleanup_rpc.sql", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("cross-source duplicate guard serializes same-user matching screenshot activities", () => {
  assert.match(duplicateGuard, /pg_advisory_xact_lock/i);
  assert.match(duplicateGuard, /a\.user_id = p_user_id/i);
  assert.match(duplicateGuard, /canonical_activity_type\(a\.activity_type\) = v_type/i);
  assert.match(duplicateGuard, /a\.activity_date between v_date - interval '3 minutes' and v_date \+ interval '3 minutes'/i);
  assert.match(duplicateGuard, /abs\(a\.duration_minutes - v_duration\) <= 2/i);
  assert.match(duplicateGuard, /abs\(a\.distance_km - v_distance\) <= 0\.05/i);
  assert.match(duplicateGuard, /reserve_activity_award\(p_user_id,p_request_key,p_activity\)/i);
  assert.match(duplicateGuard, /revoke all on function public\.reserve_screenshot_activity_award\(uuid,uuid,jsonb\) from public, anon, authenticated/i);
  assert.match(duplicateGuard, /grant execute on function public\.reserve_screenshot_activity_award\(uuid,uuid,jsonb\) to service_role/i);
  assert.doesNotMatch(duplicateGuard, /delete from|truncate |drop table/i);
});

test("cleanup migration only removes the temporary procedure and import no longer exposes smoke UI", () => {
  assert.equal(cleanup.trim(), "drop function if exists public.cleanup_phase2_browser_smoke_test(uuid);");
  assert.doesNotMatch(app, /Phase2SmokeTest|phase2-smoke/);
});

