-- Brief Three — Referrer Watch, Delta Diff, Corpus Foundry Lite.
-- Same lockdown as everything else: RLS on, owner-only reads via
-- public.is_parlor_owner(); writes happen through service-role Edge Functions or
-- owner-scoped policies. Anon with no session = zero rows.

-- ---------------------------------------------------------------- Referrer Watch
create table if not exists public.site_visits (
  id             uuid primary key default gen_random_uuid(),
  ts             timestamptz not null default now(),
  path           text,
  referrer       text,
  referrer_host  text,
  is_ai_referrer boolean not null default false,
  user_agent     text,
  country        text,
  session_id     text            -- rotating daily, NOT user-identifying. No IP stored.
);
create index if not exists idx_site_visits_ts on public.site_visits (ts desc);
create index if not exists idx_site_visits_ai on public.site_visits (is_ai_referrer, ts desc);

-- ------------------------------------------------------------------- Delta Diff
create table if not exists public.run_deltas (
  id               uuid primary key default gen_random_uuid(),
  run_id           uuid not null references public.visibility_runs(id) on delete cascade,
  prev_run_id      uuid references public.visibility_runs(id) on delete set null,
  prompt           text not null,
  category         text,
  mention_delta    int not null default 0,
  citation_added   text[] not null default '{}',
  citation_removed text[] not null default '{}',
  excerpt_note     text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_run_deltas_run on public.run_deltas (run_id);

-- -------------------------------------------------------- Corpus Foundry Lite
create table if not exists public.corpus_drafts (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  target_query    text not null,
  category        text,
  competitor_urls text[] not null default '{}',
  rationale       text,
  silk_explains   text,          -- one-line "why publish" in Silk's voice
  filename        text,          -- <slug>.md under src/content/notes/
  markdown_body   text,
  status          text not null default 'proposed'
                    check (status in ('proposed','edited','published','retracted','rejected')),
  mat_note        text,
  ledger_refs     jsonb not null default '[]'::jsonb,
  commit_sha      text,
  live_url        text,
  published_at    timestamptz,
  retracted_at    timestamptz
);
create index if not exists idx_corpus_drafts_status on public.corpus_drafts (status, created_at desc);

-- Edit history (diff view reads the latest two versions). Full history UI is out
-- of scope; this just preserves versions.
create table if not exists public.corpus_draft_versions (
  id            uuid primary key default gen_random_uuid(),
  draft_id      uuid not null references public.corpus_drafts(id) on delete cascade,
  version       int not null,
  markdown_body text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_corpus_versions_draft on public.corpus_draft_versions (draft_id, version desc);

-- --------------------------------------------------------------------- RLS
alter table public.site_visits           enable row level security;
alter table public.run_deltas            enable row level security;
alter table public.corpus_drafts         enable row level security;
alter table public.corpus_draft_versions enable row level security;

-- Owner-only reads everywhere. No anon policy.
create policy site_visits_owner_select   on public.site_visits           for select to authenticated using (public.is_parlor_owner());
create policy run_deltas_owner_select    on public.run_deltas            for select to authenticated using (public.is_parlor_owner());
create policy corpus_drafts_owner_select on public.corpus_drafts         for select to authenticated using (public.is_parlor_owner());
create policy corpus_versions_owner_select on public.corpus_draft_versions for select to authenticated using (public.is_parlor_owner());

-- Owner may edit drafts (revise body, reject) and append versions from the UI.
-- Publish/retract/generate go through service-role Edge Functions.
create policy corpus_drafts_owner_update  on public.corpus_drafts         for update to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());
create policy corpus_versions_owner_insert on public.corpus_draft_versions for insert to authenticated with check (public.is_parlor_owner());
