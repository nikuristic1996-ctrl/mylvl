-- Run after the Phase 2/6 fixtures and Nose Counter migration in disposable PostgreSQL.
do $$
declare
  first_result jsonb;
  retry_result jsonb;
  second_result jsonb;
  before_activities integer;
  before_transactions integer;
  user_id constant uuid := '11111111-1111-4111-8111-111111111111';
  first_key constant uuid := '77777777-7777-4777-8777-777777777777';
  second_key constant uuid := '88888888-8888-4888-8888-888888888888';
begin
  select count(*) into before_activities from public.activities;
  select count(*) into before_transactions from public.experience_transactions;

  first_result := public.reserve_nose_counter_award(user_id,first_key,jsonb_build_object(
    'activity_type','Push-ups','source','nose_counter','source_key',first_key::text,
    'activity_date',now()::text,'duration_minutes',5,'repetitions',10,
    'nose_counter_confirmed',true
  ));
  retry_result := public.reserve_nose_counter_award(user_id,first_key,jsonb_build_object(
    'activity_type','Push-ups','source','nose_counter','source_key',first_key::text,
    'activity_date',now()::text,'duration_minutes',5,'repetitions',10,
    'nose_counter_confirmed',true
  ));
  if coalesce((first_result->>'duplicate')::boolean,true)
    or coalesce((retry_result->>'duplicate')::boolean,false) is false
    or first_result->>'status' <> 'pending'
    or (select count(*) from public.activities) <> before_activities + 1
    or (select count(*) from public.experience_transactions) <> before_transactions then
    raise exception 'Nose Counter first reservation or duplicate guard failed';
  end if;
  if not exists(select 1 from public.activities where id=(first_result->>'activity_id')::uuid
      and source='nose_counter' and validation_status='user_confirmed'
      and validation_method='nose_touch_self_report'
      and metadata->>'self_reported'='true') then
    raise exception 'Nose Counter source or self-report metadata was not stored';
  end if;

  -- A reservation must not award EXP; the Edge Function finalizes it through the shared award RPC.
  if (select count(*) from public.experience_transactions) <> before_transactions then
    raise exception 'EXP was awarded before secure server finalization';
  end if;

  second_result := public.reserve_nose_counter_award(user_id,second_key,jsonb_build_object(
    'activity_type','pushups','source','nose_counter','source_key',second_key::text,
    'activity_date',now()::text,'duration_minutes',4,'repetitions',10,
    'nose_counter_confirmed',true
  ));
  if coalesce((second_result->>'duplicate')::boolean,true)
    or (second_result->>'daily_metric_before')::numeric <> 10 then
    raise exception 'Nose Counter daily metric aggregation did not include the first pending set';
  end if;

  if (select count(*) from public.activities where source='nose_counter') <> 2
    or (select count(*) from public.activity_award_attempts where activity_type='pushups' and request_key in (first_key,second_key)) <> 2 then
    raise exception 'Nose Counter requests created unexpected duplicate rows';
  end if;
end;
$$;

select 'Nose Counter migration assertions passed' as result;
