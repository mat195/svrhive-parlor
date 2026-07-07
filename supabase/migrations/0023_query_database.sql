-- General-purpose read-only DB access for Silk. ONE tool replaces the incremental
-- single-table read functions: query_database(sql) runs an arbitrary SELECT as a
-- least-privileged role that can read app data (schema public) but has NO access to
-- auth.* (credentials) or vault.* (secrets). Writes are impossible — they still go
-- through the gated action_queue flow, unchanged.
--
-- The security boundary is the ROLE, not string-matching: silk_readonly holds only
-- SELECT on public, so an INSERT/UPDATE/DELETE (even hidden in a data-modifying CTE)
-- fails on privileges. The regex checks are secondary hygiene.

-- 1) Least-privileged read role (no login; entered only via SET ROLE inside the fn).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'silk_readonly') then
    create role silk_readonly nologin;
  end if;
end $$;

grant usage on schema public to silk_readonly;
grant select on all tables in schema public to silk_readonly;
alter default privileges in schema public grant select on tables to silk_readonly;

-- Explicitly ensure it can never reach credentials or secrets (belt-and-suspenders;
-- a fresh role has no grants there, but state the intent).
revoke all on schema auth from silk_readonly;
revoke all on schema vault from silk_readonly;

-- The definer (postgres) must be a member of silk_readonly to SET ROLE into it.
grant silk_readonly to postgres;

-- 2) The read-only executor. SECURITY DEFINER so the service role can call it; it
--    immediately drops to silk_readonly for the actual query, caps rows + runtime.
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

  set local role silk_readonly;              -- least privilege for the real execution
  set local statement_timeout = '8s';
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) as _q limit 1000) as t',
    cleaned
  ) into result;
  reset role;
  return result;
exception when others then
  reset role;
  return jsonb_build_object('error', sqlerrm);
end $$;

revoke all on function public.query_database(text) from public;
grant execute on function public.query_database(text) to authenticated, service_role;
