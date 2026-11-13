import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Check, CircleAlert, LoaderCircle, ShieldCheck, Zap } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { levelForXp } from "./domain";
import { loadCloudData } from "./supabaseData";
import { supabase } from "./supabase";

// Temporary visibility gate for the one existing MYLVL owner account. This ID
// is not a credential; all data access still uses the signed-in Supabase JWT/RLS.
export const PHASE2_SMOKE_OWNER_ID = "9e8b3a63-0e59-4298-8ee5-ee8fdb1577a9";
const TEST_STORAGE_PREFIX = "mylvl-phase2-browser-smoke:";
const TEST_SOURCE_PREFIX = "mylvl-phase2-browser-smoke:";
const TEST_NOTE = "MYLVL Phase 2 browser smoke test (simulated running; not a real workout)";

type ReportEntry = { label: string; ok: boolean; detail: string };
type TestResponse = { status: number; body: unknown };
type TestActivityRow = { request_key: string | null; source_key: string };
type ProgressRow = { total_exp: number; current_level: number };

function storageKey(userId: string) {
  return `${TEST_STORAGE_PREFIX}${userId}`;
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function bodyObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function responseBody(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;
  return parseJson(raw);
}

function localDateForTimezone(date: Date, timezone: string) {
  const pieces = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => pieces.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export default function Phase2SmokeTest({ user }: { user: User | null }) {
  const [requestKey, setRequestKey] = useState<string | null>(null);
  const [entries, setEntries] = useState<ReportEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [hasTestRecord, setHasTestRecord] = useState(false);
  const [message, setMessage] = useState("");
  const authorized = user?.id === PHASE2_SMOKE_OWNER_ID;
  const level = entries.find((entry) => entry.label === "Frontend progression")?.detail;

  useEffect(() => {
    const client = supabase;
    if (!authorized || !user || !client) return;
    let active = true;
    const recover = async () => {
      const stored = localStorage.getItem(storageKey(user.id));
      if (stored && /^[0-9a-f-]{36}$/i.test(stored)) {
        if (active) setRequestKey(stored);
        const { data } = await client.from("activities")
          .select("request_key, source_key")
          .eq("user_id", user.id)
          .eq("source", "screenshot")
          .like("source_key", `${TEST_SOURCE_PREFIX}%`)
          .maybeSingle();
        if (active) setHasTestRecord(Boolean(data));
        return;
      }
      const { data, error } = await client.from("activities")
        .select("request_key, source_key")
        .eq("user_id", user.id)
        .eq("source", "screenshot")
        .like("source_key", `${TEST_SOURCE_PREFIX}%`)
        .limit(2);
      if (!active) return;
      if (error) {
        setMessage(`Could not check for a previous test record: ${error.message}`);
        return;
      }
      if (data?.length === 1 && (data[0] as TestActivityRow).request_key) {
        const recovered = (data[0] as TestActivityRow).request_key!;
        localStorage.setItem(storageKey(user.id), recovered);
        setRequestKey(recovered);
        setHasTestRecord(true);
      } else if (data?.length) {
        setMessage("Multiple tagged smoke-test records were found. No new test will run; contact support before cleanup.");
      }
    };
    void recover();
    return () => { active = false; };
  }, [authorized, user]);

  const append = (entry: ReportEntry) => setEntries((current) => [...current, entry]);
  const getProgress = async () => {
    const client = supabase;
    if (!client || !user) throw new Error("Sign in to the owner account first.");
    const { data, error } = await client.from("user_progress")
      .select("total_exp, current_level")
      .eq("user_id", user.id)
      .single();
    if (error) throw error;
    return data as ProgressRow;
  };

  const runTest = async () => {
    if (!authorized || !user || !supabase || busy) return;
    setBusy(true);
    setEntries([]);
    setMessage("");
    let key = requestKey;
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      const session = sessionData.session;
      if (sessionError || !session?.access_token) throw new Error("No active authenticated Supabase session. Sign in again in Settings.");

      if (!key) {
        key = crypto.randomUUID();
        localStorage.setItem(storageKey(user.id), key);
        setRequestKey(key);
      }
      const functionUrl = `${String(import.meta.env.VITE_SUPABASE_URL).replace(/\/$/, "")}/functions/v1/award-activity`;
      const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? import.meta.env.VITE_SUPABASE_ANON_KEY;
      if (!publishableKey || functionUrl.startsWith("undefined/")) {
        throw new Error("The public Supabase URL or publishable key is missing from the Vercel build.");
      }
      const requestHeaders = {
        Authorization: `Bearer ${session.access_token}`,
        apikey: publishableKey,
        "Content-Type": "application/json",
      };

      const preflight = await fetch(functionUrl, { method: "OPTIONS", headers: requestHeaders });
      const allowedOrigin = preflight.headers.get("access-control-allow-origin");
      const preflightOk = preflight.status === 204 && allowedOrigin === window.location.origin;
      append({
        label: "Production CORS preflight",
        ok: preflightOk,
        detail: `HTTP ${preflight.status}; allowed origin: ${allowedOrigin ?? "missing"}; app origin: ${window.location.origin}`,
      });
      if (!preflightOk) throw new Error("Production CORS preflight did not authorize this exact Vercel origin; no activity was submitted.");

      const progressBefore = await getProgress();
      const timezoneResult = await supabase.from("profiles").select("timezone").eq("id", user.id).maybeSingle();
      if (timezoneResult.error) throw timezoneResult.error;
      const timezone = timezoneResult.data?.timezone ?? "UTC";
      const today = localDateForTimezone(new Date(), timezone);
      const { data: attempts, error: attemptsError } = await supabase.from("activity_award_attempts")
        .select("request_key, metric_amount, status, counts_toward_cap")
        .eq("user_id", user.id)
        .eq("activity_type", "running")
        .eq("local_date", today)
        .eq("counts_toward_cap", true);
      if (attemptsError) throw attemptsError;
      const otherRuns = (attempts ?? []).filter((attempt) => attempt.request_key !== key && ["pending", "awarded"].includes(attempt.status));
      const existingActivityResult = await supabase.from("activities").select("id, request_key")
        .eq("user_id", user.id).eq("request_key", key).maybeSingle();
      if (existingActivityResult.error) throw existingActivityResult.error;
      const isResume = Boolean(existingActivityResult.data);
      if (!isResume && (progressBefore.total_exp !== 0 || progressBefore.current_level !== 1 || otherRuns.length > 0)) {
        throw new Error(`Safe test preconditions are not met (current EXP ${progressBefore.total_exp}, level ${progressBefore.current_level}, other rewarded/pending runs today ${otherRuns.length}). No test activity was submitted.`);
      }
      append({
        label: "Safe starting state",
        ok: isResume || (progressBefore.total_exp === 0 && progressBefore.current_level === 1 && otherRuns.length === 0),
        detail: `${progressBefore.total_exp.toLocaleString()} total EXP; level ${progressBefore.current_level}; ${otherRuns.length} other running award(s) today.${isResume ? " Resuming the same saved test ID." : ""}`,
      });

      const testedAt = new Date().toISOString();
      const payload = {
        requestKey: key,
        activity: {
          type: "Running",
          date: testedAt,
          duration: 63,
          distance: 6.3,
          source: "screenshot",
          sourceKey: `${TEST_SOURCE_PREFIX}${key}`,
          notes: TEST_NOTE,
          screenshotConfirmed: true,
          demo: false,
        },
      };
      const send = async (): Promise<TestResponse> => {
        const response = await fetch(functionUrl, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(payload),
        });
        const body = await responseBody(response);
        return { status: response.status, body };
      };
      const first = await send();
      const firstBody = bodyObject(first.body);
      setHasTestRecord(Boolean(firstBody.activity_id) || isResume);
      append({
        label: "First authenticated award request",
        ok: first.status === 200 && Number(firstBody.xp) === 630 && firstBody.status === "awarded",
        detail: `HTTP ${first.status}; response: ${JSON.stringify(first.body)}`,
      });
      if (first.status !== 200) throw new Error("The award request returned an HTTP error; inspect the response above. The saved request ID remains available for safe cleanup.");

      const progressAfterFirst = await getProgress();
      const firstProgressOk = progressAfterFirst.total_exp === 630 && progressAfterFirst.current_level === 2;
      append({
        label: "Persisted permanent progression",
        ok: firstProgressOk,
        detail: `Database: ${progressAfterFirst.total_exp} lifetime EXP; Level ${progressAfterFirst.current_level}. Expected: 630 EXP; Level 2.`,
      });

      const replay = await send();
      const replayBody = bodyObject(replay.body);
      append({
        label: "Same-ID duplicate request",
        ok: replay.status === 200 && replayBody.duplicate === true && Number(replayBody.xp) === 630,
        detail: `HTTP ${replay.status}; response: ${JSON.stringify(replay.body)}`,
      });
      const progressAfterReplay = await getProgress();
      append({
        label: "Progression unchanged by duplicate",
        ok: progressAfterReplay.total_exp === 630 && progressAfterReplay.current_level === 2,
        detail: `Database remains at ${progressAfterReplay.total_exp} lifetime EXP; Level ${progressAfterReplay.current_level}.`,
      });

      const activityQuery = await supabase.from("activities").select("id, request_key, source_key, distance_km")
        .eq("user_id", user.id).eq("request_key", key).maybeSingle();
      if (activityQuery.error) throw activityQuery.error;
      const activityId = activityQuery.data?.id;
      const attemptQuery = await supabase.from("activity_award_attempts").select("id, result_xp, status")
        .eq("user_id", user.id).eq("request_key", key);
      if (attemptQuery.error) throw attemptQuery.error;
      const transactionQuery = activityId
        ? await supabase.from("experience_transactions").select("id, exp_amount, transaction_type")
            .eq("user_id", user.id).eq("activity_id", activityId).eq("transaction_type", "activity")
        : { data: [], error: null };
      if (transactionQuery.error) throw transactionQuery.error;
      const persistedOk = activityQuery.data?.distance_km === 6.3
        && attemptQuery.data?.length === 1
        && attemptQuery.data[0].result_xp === 630
        && transactionQuery.data?.length === 1
        && transactionQuery.data[0].exp_amount === 630;
      setHasTestRecord(Boolean(activityQuery.data));
      append({
        label: "Database transaction consistency",
        ok: Boolean(persistedOk),
        detail: `${activityQuery.data?.distance_km ?? "missing"} km activity; ${attemptQuery.data?.length ?? 0} award attempt; ${transactionQuery.data?.length ?? 0} activity EXP transaction; stored amount ${transactionQuery.data?.[0]?.exp_amount ?? 0} EXP.`,
      });

      const cloud = await loadCloudData(user.id);
      const frontendProgress = levelForXp(cloud.totalXp);
      const frontendOk = cloud.totalXp === 630 && frontendProgress.level === 2
        && frontendProgress.current === 130 && frontendProgress.needed === 550;
      append({
        label: "Frontend progression",
        ok: frontendOk,
        detail: `App data loader + shared level engine: Level ${frontendProgress.level}; ${frontendProgress.current}/${frontendProgress.needed} EXP toward next level; ${cloud.totalXp} lifetime EXP.`,
      });
      setMessage("Verification finished. Review each result, then choose ‘Remove test activity and EXP’ to restore the prior account state.");
    } catch (error) {
      append({ label: "Test error", ok: false, detail: error instanceof Error ? error.message : "Unexpected test error." });
      setMessage("The test stopped safely. If a request created a record, use the cleanup button below before leaving this page.");
    } finally {
      setBusy(false);
    }
  };

  const cleanTest = async () => {
    if (!authorized || !user || !supabase || !requestKey || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const { data, error } = await supabase.rpc("cleanup_phase2_browser_smoke_test", { p_request_key: requestKey });
      if (error) throw error;
      const cleanup = bodyObject(data);
      const after = await getProgress();
      const activityQuery = await supabase.from("activities").select("id")
        .eq("user_id", user.id).eq("request_key", requestKey).maybeSingle();
      const attemptQuery = await supabase.from("activity_award_attempts").select("id")
        .eq("user_id", user.id).eq("request_key", requestKey);
      const transactionQuery = activityQuery.data?.id
        ? await supabase.from("experience_transactions").select("id")
            .eq("user_id", user.id).eq("activity_id", activityQuery.data.id).eq("transaction_type", "activity")
        : { data: [], error: null };
      if (activityQuery.error || attemptQuery.error || transactionQuery.error) {
        throw activityQuery.error ?? attemptQuery.error ?? transactionQuery.error;
      }
      const removed = !activityQuery.data && attemptQuery.data?.length === 0 && transactionQuery.data?.length === 0;
      const expectedTotal = typeof cleanup.total_exp_after_cleanup === "number"
        ? cleanup.total_exp_after_cleanup
        : 0;
      const progressRestored = after.total_exp === expectedTotal;
      const cleanupOk = removed && progressRestored;
      setEntries((current) => [...current, {
        label: "Server-side transactional cleanup",
        ok: cleanupOk,
        detail: `${JSON.stringify(data)}; remaining test activity/attempt/transaction: ${activityQuery.data ? "activity present" : "no activity"}/${attemptQuery.data?.length ?? 0}/${transactionQuery.data?.length ?? 0}; account total EXP now ${after.total_exp}.`,
      }]);
      if (cleanupOk) {
        localStorage.removeItem(storageKey(user.id));
        setRequestKey(null);
        setHasTestRecord(false);
        setMessage("The marked test activity, award attempt and EXP transaction are gone. Progression was restored from the server’s transaction result.");
      } else {
        setMessage("Cleanup returned, but verification found remaining test data or a balance mismatch. Do not run another test; share this report.");
      }
    } catch (error) {
      append({ label: "Cleanup error", ok: false, detail: error instanceof Error ? error.message : "Unexpected cleanup error." });
      setMessage("Cleanup stopped without broad data changes. The server explains why; share that message before retrying.");
    } finally {
      setBusy(false);
    }
  };

  if (!user) {
    return <section className="panel phase2-smoke-card"><h1>Phase 2 verification</h1><p>Sign in with the MYLVL owner account in Settings to open this temporary test page.</p><Link className="secondary-button" to="/settings">Open Settings</Link></section>;
  }
  if (!authorized) {
    return <section className="panel phase2-smoke-card"><h1>Phase 2 verification</h1><p>This temporary test page is available only to the MYLVL owner account.</p><Link className="secondary-button" to="/">Back to overview</Link></section>;
  }

  const hasErrors = entries.some((entry) => !entry.ok);
  return (
    <div className="phase2-smoke-page">
      <div className="phase2-smoke-back"><Link to="/settings"><ArrowLeft size={17} /> Back to Settings</Link></div>
      <div className="eyebrow">TEMPORARY PRODUCTION CHECK</div>
      <h1>Phase 2 browser smoke test</h1>
      <p className="phase2-smoke-lede">This submits one clearly marked simulated Running activity through the live award endpoint. It uses your current sign-in, creates no admin access, and can be reversed with the server-side cleanup below.</p>
      <section className="panel phase2-smoke-card">
        <div className="phase2-smoke-card-title"><ShieldCheck size={21} /><div><h2>Fixed test scenario</h2><p>Running · 6.3 km · 63 min · screenshot-confirmed simulation</p></div></div>
        <ul className="phase2-smoke-facts">
          <li>Expected award: <b>630 EXP</b> (subject to the clean starting-state check).</li>
          <li>Expected permanent progression: <b>Level 2 · 130/550 EXP</b> toward Level 3.</li>
          <li>A second submission reuses the same request ID to verify duplicate protection.</li>
          <li>The app checks production CORS and verifies the activity, award attempt, EXP transaction and frontend progress.</li>
        </ul>
        {message && <p className="phase2-smoke-message" role="status">{message}</p>}
        <div className="phase2-smoke-actions">
          <button className="primary-button" onClick={() => void runTest()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Zap size={17} />}
            {hasTestRecord ? "Replay same test ID" : "Run simulated 6.3 km test"}
          </button>
          {requestKey && <button className="secondary-button phase2-smoke-clean" onClick={() => void cleanTest()} disabled={busy}>
            {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
            Remove test activity and EXP
          </button>}
        </div>
      </section>
      {entries.length > 0 && <section className="panel phase2-smoke-report" aria-live="polite">
        <div className="phase2-smoke-report-heading"><div><div className="eyebrow">LIVE RESULTS</div><h2>Test report</h2></div><span className={hasErrors ? "smoke-report-status failed" : "smoke-report-status"}>{hasErrors ? <CircleAlert size={16} /> : <Check size={16} />}{hasErrors ? "Needs attention" : "Checks passed"}</span></div>
        <div className="phase2-smoke-results">
          {entries.map((entry, index) => <article className="phase2-smoke-result" key={`${entry.label}-${index}`}>
            <span className={entry.ok ? "smoke-result-icon passed" : "smoke-result-icon failed"}>{entry.ok ? <Check size={16} /> : <CircleAlert size={16} />}</span>
            <div><h3>{entry.label}</h3><p>{entry.detail}</p></div>
          </article>)}
        </div>
        {level && <p className="phase2-smoke-live-progress">Current app calculation: {level}</p>}
      </section>}
      <p className="phase2-smoke-footnote">The test ID is random and unique. Cleanup only accepts this account’s tagged 6.3 km record; it refuses cleanup if later EXP or another running award could be affected.</p>
    </div>
  );
}

