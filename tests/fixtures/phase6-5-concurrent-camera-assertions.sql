\set ON_ERROR_STOP on
do $$
begin
  if (select count(*) from public.activities where request_key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 1
    or (select count(*) from public.activity_award_attempts where request_key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') <> 1 then
    raise exception 'Concurrent duplicate camera requests created multiple rows';
  end if;
end;
$$;
