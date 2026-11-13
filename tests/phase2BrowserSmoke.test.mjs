import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261113150000_phase2_browser_smoke_cleanup.sql", import.meta.url), "utf8");
const page = await readFile(new URL("../src/Phase2SmokeTest.tsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("smoke test uses the active signed-in session and sends a fixed 6.3 km request", () => {
  assert.match(page, /supabase\.auth\.getSession\(\)/);
  assert.match(page, /Bearer \$\{session\.access_token\}/);
  assert.match(page, /type: "Running"[\s\S]*?duration: 63[\s\S]*?distance: 6\.3/);
  assert.match(page, /requestKey: key/);
  assert.match(page, /sourceKey: `\$\{TEST_SOURCE_PREFIX\}\$\{key\}`/);
  assert.match(page, /screenshotConfirmed: true[\s\S]*?demo: false/);
  assert.match(page, /Run simulated 6\.3 km test/);
});

test("browser smoke page gates visibility to the single MYLVL owner id", () => {
  assert.match(page, /export const PHASE2_SMOKE_OWNER_ID = "[0-9a-f-]{36}"/);
  assert.match(page, /const authorized = user\?\.id === PHASE2_SMOKE_OWNER_ID/);
  assert.match(app, /canRunPhase2SmokeTest=\{userId === PHASE2_SMOKE_OWNER_ID\}/);
});

test("test verifies duplicate, CORS, database rows, and real app progression values", () => {
  assert.match(page, /method: "OPTIONS"/);
  assert.match(page, /cross-origin fetch resolved, so the browser accepted CORS/);
  assert.match(page, /Access-Control-Allow-Origin is not a CORS-safelisted response header/);
  assert.match(page, /replayBody\.duplicate === true/);
  assert.match(page, /transactionQuery\.data\[0\]\.exp_amount === 630/);
  assert.match(page, /frontendProgress\.current === 130 && frontendProgress\.needed === 550/);
});

test("cleanup is owner-bound, tagged-record-only, transactional, and restores ledger deltas", () => {
  assert.match(migration, /security definer\s+set search_path = ''/i);
  assert.match(migration, /v_user_id <> '[0-9a-f-]{36}'::uuid/i);
  assert.match(migration, /mylvl-phase2-browser-smoke:/);
  assert.match(migration, /distance_km <> 6\.3/);
  assert.match(migration, /delete from public\.experience_transactions where id = v_tx\.id/i);
  assert.match(migration, /set total_exp = v_total_after, current_level = v_level_after/i);
  assert.match(migration, /delete from public\.activities where id = v_activity\.id and user_id = v_user_id/i);
  assert.match(migration, /later EXP transaction exists/);
  assert.match(migration, /later running activity shares this daily limit/);
  assert.match(migration, /revoke all on function public\.cleanup_phase2_browser_smoke_test\(uuid\) from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.cleanup_phase2_browser_smoke_test\(uuid\) to authenticated/i);
  assert.doesNotMatch(migration, /drop\s+table|truncate\s+/i);
});

test("cleanup is called only for its persisted random request key and verifies removal", () => {
  assert.match(page, /rpc\("cleanup_phase2_browser_smoke_test", \{ p_request_key: requestKey \}\)/);
  assert.match(page, /remaining test activity\/attempt\/transaction/);
  assert.match(page, /localStorage\.removeItem\(storageKey\(user\.id\)\)/);
});

