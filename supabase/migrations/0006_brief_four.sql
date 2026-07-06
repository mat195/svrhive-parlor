-- Brief Four — Parlor-as-HQ backend: persistent brain layout, focus log,
-- Silk's questions queue. Owner-only (RLS).

-- Persist graph node positions per Mat (single-user) so the Brain feels like his room.
create table if not exists public.brain_positions (
  node_key    text primary key,
  x           double precision,
  y           double precision,
  updated_at  timestamptz not null default now()
);

-- What node Mat is looking at + when (context for Silk; usage signal).
create table if not exists public.silk_focus (
  id          uuid primary key default gen_random_uuid(),
  node_key    text,
  room        text,
  focused_at  timestamptz not null default now()
);

-- Silk's Questions — pinned, urgency-scored, dismissible, answer-routed.
create table if not exists public.silk_questions (
  id           uuid primary key default gen_random_uuid(),
  question     text not null,
  context      text,
  source_ref   jsonb not null default '{}'::jsonb,   -- {kind,id,node_key}
  urgency      int not null default 5,               -- higher = more urgent
  status       text not null default 'open' check (status in ('open','answered','dismissed')),
  answer       text,
  dismissed_count int not null default 0,
  created_at   timestamptz not null default now(),
  answered_at  timestamptz
);
create index if not exists idx_silk_questions_open on public.silk_questions (status, urgency desc, created_at desc);

alter table public.brain_positions enable row level security;
alter table public.silk_focus      enable row level security;
alter table public.silk_questions  enable row level security;

create policy brain_positions_owner_all on public.brain_positions for all to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());
create policy silk_focus_owner_select   on public.silk_focus     for select to authenticated using (public.is_parlor_owner());
create policy silk_focus_owner_insert   on public.silk_focus     for insert to authenticated with check (public.is_parlor_owner());
create policy silk_questions_owner_select on public.silk_questions for select to authenticated using (public.is_parlor_owner());
create policy silk_questions_owner_update on public.silk_questions for update to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());
