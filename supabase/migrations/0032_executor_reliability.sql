-- Trust-critical fix: the approval→execution path was silently stalling.
--   (1) The dispatch trigger's `executable` list omitted bio-approval / bio-revision /
--       tier-reclass / genre-change / revise-role / reference-swap / appears-on-audit /
--       catalog-backfill — so those approvals NEVER dispatched to silk-executor.
--   (2) silk-executor has a sweep mode (retry stragglers + re-verify awaiting-site items),
--       but NO cron ever invoked it — so when the trigger's async net.http_post failed to
--       deliver, approved items sat at exec=None forever with nothing to catch them.
-- This migration widens the executable set and schedules the sweep as the reliability
-- backstop AND the live-site re-verification loop.

-- ── 1) Widen the dispatch executable set ─────────────────────────────────────
create or replace function public.dispatch_execution() returns trigger
  language plpgsql security definer set search_path = public, extensions, vault as $$
declare
  executable text[] := array[
    'corpus-initiative','corpus-page','audit-initiative','catalog-audit',
    'answer-cascade','metadata-fix','bio-approval','bio-revision','tier-reclass',
    'genre-change','revise-role','reference-swap','appears-on-audit','catalog-backfill'];
  anon text; cron text; ref text := 'fitpvesrrirezbndkelo';
begin
  if new.status = 'approved' and coalesce(old.status,'') <> 'approved'
     and new.kind = any(executable) and coalesce(new.risk_tier,'') <> 'red'
     and coalesce((new.payload->>'draft_created')::boolean, false) is not true
     and coalesce((new.payload->>'executed')::boolean, false) is not true then
    select decrypted_secret into anon from vault.decrypted_secrets where name = 'anon_key';
    select decrypted_secret into cron from vault.decrypted_secrets where name = 'cron_key';
    perform net.http_post(
      url := 'https://' || ref || '.supabase.co/functions/v1/silk-executor',
      headers := jsonb_build_object('Content-Type','application/json','apikey',anon,'Authorization','Bearer '||anon,'x-cron-key',cron),
      body := jsonb_build_object('item_id', new.id::text)::jsonb
    );
  end if;
  return new;
end $$;

-- ── 2) Schedule the executor sweep (every 10 min) ────────────────────────────
-- Backstop for undelivered triggers + the live-site re-verification loop: any approved
-- executable item the trigger missed gets executed, and any item held `awaiting_site`
-- gets its live surface re-checked and auto-closed once the public site reflects it.
select cron.schedule(
  'silk_executor_sweep',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://fitpvesrrirezbndkelo.supabase.co/functions/v1/silk-executor',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_key')
    ),
    body := jsonb_build_object('sweep', true)::jsonb
  );
  $$
);
