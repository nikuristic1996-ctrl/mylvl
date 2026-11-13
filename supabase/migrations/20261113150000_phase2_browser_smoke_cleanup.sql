-- Temporary, narrowly scoped cleanup for the Phase 2 browser smoke test.
-- It can only remove the exact tagged 6.3 km test activity owned by the MYLVL owner.
begin;

create or replace function public.cleanup_phase2_browser_smoke_test(p_request_key uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_attempt public.activity_award_attempts%rowtype;
  v_activity public.activities%rowtype;
  v_tx public.experience_transactions%rowtype;
  v_total_before bigint;
  v_total_after bigint;
  v_level_before integer;
  v_level_after integer;
  v_exp integer := 0;
  v_had_transaction boolean := false;
begin
  if v_user_id is null or v_user_id <> '9e8b3a63-0e59-4298-8ee5-ee8fdb1577a9'::uuid then
    raise exception 'This cleanup is restricted to the MYLVL owner account.';
  end if;
  if p_request_key is null then raise exception 'A test request key is required.'; end if;

  select * into v_attempt
    from public.activity_award_attempts
    where user_id = v_user_id and request_key = p_request_key
    for update;
  if not found then
    return jsonb_build_object('already_cleaned', true);
  end if;

  select * into v_activity
    from public.activities
    where id = v_attempt.activity_id and user_id = v_user_id
    for update;
  if not found
    or v_activity.source <> 'screenshot'
    or v_activity.source_key <> 'mylvl-phase2-browser-smoke:' || p_request_key::text
    or v_activity.notes <> 'MYLVL Phase 2 browser smoke test (simulated running; not a real workout)'
    or v_activity.activity_type <> 'running'
    or v_activity.distance_km <> 6.3
    or v_activity.duration_minutes <> 63
    or v_activity.validation_status <> 'user_confirmed'
    or coalesce((v_activity.metadata ->> 'demo')::boolean, true)
  then
    raise exception 'The record does not match the fixed Phase 2 smoke-test activity.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || ':' || v_attempt.local_date::text || ':running', 0)
  );

  if v_attempt.transaction_id is not null then
    select * into v_tx
      from public.experience_transactions
      where id = v_attempt.transaction_id and user_id = v_user_id
      for update;
    if not found or v_tx.activity_id <> v_activity.id or v_tx.transaction_type <> 'activity' then
      raise exception 'The smoke-test EXP transaction is missing or inconsistent.';
    end if;
    v_had_transaction := true;
    v_exp := v_tx.exp_amount;

    if exists (
      select 1 from public.experience_transactions later
      where later.user_id = v_user_id and later.id <> v_tx.id and later.created_at > v_tx.created_at
    ) then
      raise exception 'A later EXP transaction exists; cleanup stopped to preserve progression history.';
    end if;
  elsif v_attempt.result_xp <> 0 then
    raise exception 'The award attempt reports EXP but has no linked transaction.';
  end if;

  if exists (
    select 1 from public.activity_award_attempts later
    where later.user_id = v_user_id and later.id <> v_attempt.id
      and later.local_date = v_attempt.local_date and later.activity_type = 'running'
      and later.created_at > v_attempt.created_at and later.counts_toward_cap
      and later.status in ('pending','awarded')
  ) then
    raise exception 'A later running activity shares this daily limit; cleanup stopped to preserve its award.';
  end if;

  select total_exp, current_level into v_total_before, v_level_before
    from public.user_progress where user_id = v_user_id for update;
  if v_had_transaction then
    if v_total_before < v_exp then raise exception 'EXP balance is inconsistent; cleanup stopped.'; end if;
    v_total_after := v_total_before - v_exp;
    v_level_after := public.permanent_level_for_exp(v_total_after);

    if v_tx.season_id is not null then
      update public.season_progress
        set season_exp = season_exp - v_exp,
            season_level = public.season_level_for_exp(season_exp - v_exp),
            season_rank = public.season_rank_for_exp(season_exp - v_exp),
            updated_at = now()
        where user_id = v_user_id and season_id = v_tx.season_id and season_exp >= v_exp;
      if not found then raise exception 'Season progression is inconsistent; cleanup stopped.'; end if;
    end if;

    delete from public.experience_transactions where id = v_tx.id;
    update public.user_progress
      set total_exp = v_total_after, current_level = v_level_after, updated_at = now()
      where user_id = v_user_id;
    delete from public.permanent_level_history
      where user_id = v_user_id and source = 'earned'
        and level > public.permanent_level_for_exp(v_total_after)
        and level <= public.permanent_level_for_exp(v_total_before);
  else
    v_total_after := coalesce(v_total_before, 0);
    v_level_after := coalesce(v_level_before, 1);
  end if;

  -- The attempt, duplicate-check rows, and request/source-key uniqueness are removed
  -- by the activity's existing ON DELETE CASCADE constraints.
  delete from public.activities where id = v_activity.id and user_id = v_user_id;

  return jsonb_build_object(
    'already_cleaned', false,
    'removed_exp', v_exp,
    'total_exp_before_cleanup', coalesce(v_total_before, 0),
    'total_exp_after_cleanup', v_total_after,
    'level_before_cleanup', coalesce(v_level_before, 1),
    'level_after_cleanup', v_level_after
  );
end;
$$;

revoke all on function public.cleanup_phase2_browser_smoke_test(uuid) from public, anon, authenticated;
grant execute on function public.cleanup_phase2_browser_smoke_test(uuid) to authenticated;
commit;

