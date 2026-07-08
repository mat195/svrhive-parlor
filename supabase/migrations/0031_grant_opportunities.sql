-- Opportunity Finder — Grants module (Phase 1). A weekly job harvests the deadline/
-- eligibility pages of Canadian arts funders (FACTOR, Musicaction, SOCAN Foundation,
-- CALQ, Canada Council), extracts each program, and screens it for whether LPT / Silk
-- Velvet Records plausibly qualifies. Informational only: Mat reviews and decides whether
-- to apply — nothing here auto-applies to anything.

-- ── 1) The findings table ────────────────────────────────────────────────────
create table if not exists public.grant_opportunities (
  id                  uuid primary key default gen_random_uuid(),
  -- Stable dedupe key = funder + program slug, so weekly re-runs UPSERT in place.
  program_id          text not null unique,
  funder              text not null,               -- e.g. "FACTOR", "CALQ"
  program_name        text not null,
  deadline            date,                         -- null = rolling / not stated on page
  deadline_note       text,                         -- verbatim/normalized date context
  eligibility_summary text,
  funding_min         int,                          -- CAD, where a number is stated
  funding_max         int,
  funding_note        text,                         -- e.g. "50% of eligible expenses, max $10,000"
  application_url     text,                         -- the program's own apply/info URL
  relevance           text not null default 'maybe' -- 'fit' | 'maybe' | 'not_eligible'
                        check (relevance in ('fit', 'maybe', 'not_eligible')),
  relevance_note      text,                         -- the deciding factor, one line
  recurring_annual    boolean not null default false,
  source_url          text not null,                -- the page we harvested
  source_excerpt      text,                         -- provenance: verbatim snippet the fields came from
  status              text not null default 'active' -- 'active' | 'archived'
                        check (status in ('active', 'archived')),
  first_seen          timestamptz not null default now(),
  fetched_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_grant_opportunities_deadline  on public.grant_opportunities (deadline asc nulls last);
create index if not exists idx_grant_opportunities_relevance on public.grant_opportunities (relevance);
create index if not exists idx_grant_opportunities_fetched   on public.grant_opportunities (fetched_at desc);

-- Owner-only read (matches every other Parlor table). Writes come from the harvest
-- function via the service-role client, which bypasses RLS — so no insert/update policy
-- is needed. The UI is read-only informational, so select is all that's exposed.
alter table public.grant_opportunities enable row level security;
drop policy if exists grant_opportunities_owner_select on public.grant_opportunities;
create policy grant_opportunities_owner_select
  on public.grant_opportunities for select to authenticated
  using (public.is_parlor_owner());

-- ── 2) Weekly harvest schedule ───────────────────────────────────────────────
-- Monday 13:30 UTC (~09:30 ET). Keys from Vault, matching the spotify_metrics dispatch
-- pattern; nothing secret lives in the repo. Re-runnable: cron.schedule upserts by name.
select cron.schedule(
  'grant_harvest_weekly',
  '30 13 * * 1',
  $$
  select net.http_post(
    url := 'https://fitpvesrrirezbndkelo.supabase.co/functions/v1/grant-harvest',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
