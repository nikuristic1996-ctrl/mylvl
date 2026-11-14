import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261114090000_season_lifecycle_rewards_dashboard.sql", import.meta.url), "utf8");
const source = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("first season is prepared but not activated or assigned a production start date", () => {
  assert.match(migration, /first_start_at\s+timestamptz/i);
  assert.match(migration, /enabled\s+boolean\s+not null default false/i);
  assert.match(migration, /values\s*\(true,\s*null,\s*'Season 01 – Find Your Rhythm',\s*false\)/i);
  assert.doesNotMatch(migration, /select\s+public\.activate_first_season\s*\(/i);
  assert.match(migration, /grant execute on function public\.activate_first_season\(timestamptz\) to service_role/i);
});

test("schedule uses serialized, deterministic, exact 84-day UTC windows", () => {
  assert.match(migration, /pg_advisory_xact_lock\(731904210\)/);
  assert.match(migration, /7257600/);
  assert.match(migration, /interval '2016 hours'/i);
  assert.match(migration, /on conflict \(season_key\) do nothing/i);
  assert.match(migration, /before insert on public\.activity_award_attempts/i);
  assert.match(migration, /new\.season_id := v_season_id/i);
});

test("late imports use receipt time and do not backfill the activity's old season", () => {
  const start = migration.indexOf("create or replace function public.resolve_activity_award_season");
  const end = migration.indexOf("$$;", start) + 3;
  const resolver = migration.slice(start, end);
  assert.match(resolver, /where starts_at <= now\(\) and now\(\) < ends_at/i);
  assert.doesNotMatch(resolver, /activity_date/i);
});

test("reward grants are unique, server-owned and private to each owner", () => {
  assert.match(migration, /primary key \(user_id, reward_key\)/i);
  assert.match(migration, /on conflict \(user_id, reward_key\) do nothing/i);
  assert.match(migration, /after insert or update of season_exp on public\.season_progress/i);
  assert.match(migration, /using \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(migration, /revoke all on public\.season_reward_catalog, public\.user_cosmetic_rewards from public, anon, authenticated/i);
  assert.match(migration, /grant select on public\.season_reward_catalog, public\.user_cosmetic_rewards to authenticated/i);
});

test("dashboard statistics are derived from the caller's RLS-visible records", () => {
  assert.match(migration, /get_my_progression_stats\(\)[\s\S]*?security invoker/i);
  assert.match(migration, /select \(select auth\.uid\(\)\) as user_id/i);
  assert.match(migration, /grant execute on function public\.get_my_progression_stats\(\) to authenticated/i);
  assert.match(migration, /measuredRunningSteps/i);
  assert.match(migration, /estimatedRunningSteps/i);
  assert.match(source, /No activities yet/);
  assert.match(source, /Season 01 – Find Your Rhythm is prepared but not activated/);
});

