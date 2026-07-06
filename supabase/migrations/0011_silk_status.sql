-- Silk Presence Bar — Silk's presence is legible at all times. Every long-running
-- action writes here on start / step / done. Append-only (powers a future activity
-- log in Archive). Owner-only (RLS) + realtime.
create table if not exists public.silk_status (
  id           uuid primary key default gen_random_uuid(),
  state        text not null check (state in ('idle', 'listening', 'thinking', 'working', 'reporting')),
  label        text,
  sublabel     text,
  progress     jsonb,                    -- e.g. {"done": 32, "total": 53}
  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  done_at      timestamptz,              -- null = still active
  source       text                      -- which function/skill emitted this
);
create index if not exists idx_silk_status_active on public.silk_status (done_at, updated_at desc);

alter table public.silk_status enable row level security;
create policy silk_status_owner_select on public.silk_status for select to authenticated using (public.is_parlor_owner());
-- owner may mark a stale task done from the client (heartbeat cleanup)
create policy silk_status_owner_update on public.silk_status for update to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());

do $$
begin
  alter publication supabase_realtime add table public.silk_status;
exception when duplicate_object then null; end $$;
