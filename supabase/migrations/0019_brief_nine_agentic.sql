-- Brief Nine (P0): session state + referent pinning, session event log, resumable
-- task checkpoints, and gated approval→execution dispatch.

-- P0-1: per-chat session state — open loops (awaiting-Mat items) + last-N turns.
create table if not exists public.silk_session_state (
  session_id   text primary key,
  open_loops   jsonb not null default '[]'::jsonb,
  last_n_turns jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

-- P0-1: append-only session event log — current-session truth (never from retrieval).
create table if not exists public.silk_session_events (
  id          uuid primary key default gen_random_uuid(),
  session_id  text not null,
  event_type  text not null,           -- tool_call | filing | finding | question | resolve
  description text,
  item_id     text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_session_events on public.silk_session_events (session_id, created_at desc);

-- P0-2: resumable task checkpoints for long/rate-limited agent runs.
create table if not exists public.silk_task_checkpoints (
  id          uuid primary key default gen_random_uuid(),
  session_id  text,
  task        text,
  state       jsonb not null default '{}'::jsonb,
  status      text not null default 'running' check (status in ('running','blocked','done','error')),
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_task_checkpoints on public.silk_task_checkpoints (status, updated_at desc);

alter table public.silk_session_state enable row level security;
alter table public.silk_session_events enable row level security;
alter table public.silk_task_checkpoints enable row level security;
create policy silk_session_state_owner on public.silk_session_state for select to authenticated using (public.is_parlor_owner());
create policy silk_session_events_owner on public.silk_session_events for select to authenticated using (public.is_parlor_owner());
create policy silk_task_checkpoints_owner on public.silk_task_checkpoints for select to authenticated using (public.is_parlor_owner());

-- P0-3: approval → execution dispatch. When an action_queue item flips to approved
-- (executable kind, not red, not already executed), invoke silk-executor. Keys read
-- from Vault so nothing secret lives in the repo.
create or replace function public.dispatch_execution() returns trigger language plpgsql as $$
declare
  executable text[] := array['corpus-initiative','corpus-page','answer-cascade','audit-initiative','catalog-audit','metadata-fix'];
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

drop trigger if exists trg_dispatch_execution on public.action_queue;
create trigger trg_dispatch_execution after update on public.action_queue
  for each row execute function public.dispatch_execution();
