-- SVRHIVE / Silk V1 — initial schema.
--
-- Security model (hard rule from Brief Zero):
--   * RLS is ENABLED on every table.
--   * NO policies are created for anon/authenticated roles.
--   * With RLS on and no policies, those roles have ZERO access. Only the
--     service_role (which bypasses RLS) can read/write. All Silk scripts run
--     server-side with the service key from env — never the anon key.
--
-- Append-only philosophy (Verdant server_history lineage): the ledger only
-- grows. Code never UPDATEs or DELETEs visibility_* or silk_journal rows.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- ACTIVE TABLES (written by the battery every run)
-- ---------------------------------------------------------------------------

-- One row per battery run.
create table if not exists public.visibility_runs (
  id                    uuid primary key default gen_random_uuid(),
  run_at                timestamptz not null default now(),
  prompt_count          int not null default 0,
  engine_count          int not null default 0,
  mentions_total        int not null default 0,   -- artist-name hits across all cells
  label_mentions_total  int not null default 0,   -- "silk velvet" hits (logged separately)
  notes                 text
);

-- One row per prompt x engine cell.
create table if not exists public.visibility_results (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references public.visibility_runs(id) on delete cascade,
  category         text not null,
  prompt           text not null,
  engine           text not null,
  model            text,
  mentioned        boolean not null default false,   -- artist canonical-name variants
  label_mentioned  boolean not null default false,   -- "silk velvet" (logged separately)
  response_excerpt text check (char_length(response_excerpt) <= 1000),
  citations        jsonb not null default '[]'::jsonb,
  error            text,
  created_at       timestamptz not null default now()
);

-- Silk's running observations. Append-only; nullable run_id for freestanding notes.
create table if not exists public.silk_journal (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid references public.visibility_runs(id) on delete set null,
  entry       text not null,
  tags        text[] not null default '{}',
  created_at  timestamptz not null default now()
);

create index if not exists idx_visibility_results_run_engine_mentioned
  on public.visibility_results (run_id, engine, mentioned);

-- ---------------------------------------------------------------------------
-- FUTURE TABLES (created empty now; populated by later briefs)
-- ---------------------------------------------------------------------------

create table if not exists public.entity_facts (
  id          uuid primary key default gen_random_uuid(),
  key         text not null,
  value       text,
  source      text,
  confidence  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.link_graph (
  id          uuid primary key default gen_random_uuid(),
  platform    text not null,
  url         text,
  status      text,
  created_at  timestamptz not null default now()
);

create table if not exists public.releases (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  release_date  date,
  upc           text,
  label_credit  text,
  created_at    timestamptz not null default now()
);

create table if not exists public.tracks (
  id          uuid primary key default gen_random_uuid(),
  release_id  uuid references public.releases(id) on delete cascade,
  title       text not null,
  isrc        text,
  created_at  timestamptz not null default now()
);

create table if not exists public.mentions_ledger (
  id          uuid primary key default gen_random_uuid(),
  url         text not null unique,
  source      text,
  query       text,
  found_at    timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

create table if not exists public.metrics_snapshots (
  id           uuid primary key default gen_random_uuid(),
  platform     text not null,
  metric       text not null,
  value        numeric,
  captured_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create table if not exists public.action_queue (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  payload     jsonb not null default '{}'::jsonb,
  status      text not null default 'pending',
  created_at  timestamptz not null default now()
);

create table if not exists public.drafts (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null,
  content     text,
  status      text not null default 'draft',
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- RLS: enable on EVERY table, create NO anon/authenticated policies.
-- ---------------------------------------------------------------------------

alter table public.visibility_runs     enable row level security;
alter table public.visibility_results  enable row level security;
alter table public.silk_journal        enable row level security;
alter table public.entity_facts        enable row level security;
alter table public.link_graph          enable row level security;
alter table public.releases            enable row level security;
alter table public.tracks              enable row level security;
alter table public.mentions_ledger     enable row level security;
alter table public.metrics_snapshots   enable row level security;
alter table public.action_queue        enable row level security;
alter table public.drafts              enable row level security;
