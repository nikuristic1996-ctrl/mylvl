# Phase 2 local integration tests

These tests target only a disposable local Supabase stack. They refuse remote API hosts and use generated `example.test` accounts that are deleted afterward. Never use production keys here.

## Required tools

- Docker Desktop, running
- Supabase CLI (`npx supabase --version` can run it without a global installation)
- Node.js 20+ and the project dependencies
- Deno (used by the Supabase Functions runtime; `deno --version`)

## Start from a fresh local database

The production project currently has no migration history because its original schema was applied manually. Do **not** add `schema.sql` as a new production migration. For a clean local stack:

1. From the project root, run `npx supabase start`. The local project ID in `supabase/config.toml` is `mylvl-phase2-local`, deliberately different from production.
2. Open the local Studio URL printed by the CLI (normally `http://127.0.0.1:54323`). In its SQL Editor, run `supabase/schema.sql` first, then `supabase/migrations/20261113010000_phase_2_secure_progression.sql`.
3. In `supabase/functions/`, copy `.env.example` to `.env.local`. Keep its CORS values for local development; do not place keys in this file in the repository.
4. In a second terminal, run `npx supabase functions serve award-activity --env-file supabase/functions/.env.local`. The local Supabase runtime supplies its local API keys. If your CLI version requires explicit values, use a temporary env file outside Git with the local `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`, plus the CORS values from `.env.example`.
5. In another terminal, set test-only values from `npx supabase status -o env` without printing them, then run:

```powershell
$status = npx supabase status -o env
foreach ($line in $status) {
  if ($line -match '^API_URL="(.*)"$') { $env:SUPABASE_URL = $Matches[1] }
  if ($line -match '^ANON_KEY="(.*)"$') { $env:SUPABASE_ANON_KEY = $Matches[1] }
  if ($line -match '^SERVICE_ROLE_KEY="(.*)"$') { $env:SUPABASE_SERVICE_ROLE_KEY = $Matches[1] }
}
$env:AWARD_FUNCTION_URL = "$($env:SUPABASE_URL)/functions/v1/award-activity"
$env:PHASE2_INTEGRATION = "1"
npm run test:integration
```

The test suite verifies the migration-backed Edge path, RLS, client write rejection, duplicate requests, concurrent mixed-case activity requests, the daily cap, permanent and seasonal progression, and CORS preflight. Test users are removed in teardown.

## Production backup and rollback plan (not executed)

Before any production change, take and verify a Supabase project backup from the Dashboard (or a secure database dump stored outside the repository). Record the profile, activity, transaction, and progress row counts and the sum of `user_progress.total_exp` so those values can be compared after migration. Do not put database passwords or service keys in the repository or this chat.

The migration is wrapped in a transaction: a SQL failure before commit should roll back the whole migration. After commit, prefer a forward-fix migration; there is intentionally no destructive down migration. If the app or Function fails after migration, keep the additive schema and repair/redeploy the compatible app/Function. A full backup restore is the last resort because it can discard writes made after the backup and should be planned as a separate maintenance operation.

The migration revokes the old `record_activity` RPC. The currently deployed frontend still calls that RPC, so activity saves can fail during the interval between the database migration and the Vercel deployment. Schedule a short maintenance window and complete the remaining deployment steps promptly; do not re-grant the insecure old award path as a rollback shortcut.

## Resetting the disposable stack

Do not rerun the baseline or Phase 2 SQL against an already-migrated database. To get a clean disposable database, stop the local Supabase stack, change the local-only `project_id` to a new unique value, start the stack again, then repeat the two SQL scripts in order. This isolates each run from both production and prior local test data.

