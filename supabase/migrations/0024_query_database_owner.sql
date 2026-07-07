-- Fix: Postgres forbids SET ROLE inside a SECURITY DEFINER function. The correct way to
-- run the query with least privilege is to make the function OWNED BY silk_readonly —
-- then SECURITY DEFINER executes it with that role's grants (SELECT-on-public only)
-- directly, no runtime role switch. Callers (authenticated/service_role) just need
-- EXECUTE; the query runs as silk_readonly regardless.

create or replace function public.query_database(query text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result  jsonb;
  cleaned text := btrim(query);
begin
  cleaned := regexp_replace(cleaned, ';\s*$', '');            -- allow one trailing ;
  if position(';' in cleaned) > 0 then
    raise exception 'query_database: only a single statement is allowed';
  end if;
  if lower(cleaned) !~ '^(select|with)\s' then
    raise exception 'query_database: only SELECT / WITH queries are allowed';
  end if;

  set local statement_timeout = '8s';
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) as _q limit 1000) as t',
    cleaned
  ) into result;
  return result;
exception when others then
  return jsonb_build_object('error', sqlerrm);
end $$;

-- Transfer ownership to the least-privileged role. ALTER OWNER requires the new owner to
-- hold CREATE on the schema, so grant it just for the transfer, then revoke — silk_readonly
-- must never be able to create objects at runtime.
grant create on schema public to silk_readonly;
alter function public.query_database(text) owner to silk_readonly;
revoke create on schema public from silk_readonly;

revoke all on function public.query_database(text) from public;
grant execute on function public.query_database(text) to authenticated, service_role;
