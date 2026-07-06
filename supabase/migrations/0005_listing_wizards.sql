-- Brief Three Part 4 — Listing Wizards. Guided, step-by-step paste flow for the
-- entity submissions, generated from the entity master. Owner-only (RLS).

create table if not exists public.listing_wizards (
  id          uuid primary key default gen_random_uuid(),
  key         text not null unique,       -- e.g. "mb-artist"
  title       text not null,
  platform    text not null,              -- MusicBrainz | Wikidata
  entity      text not null,              -- artist | label | releases
  order_index int not null,               -- enforced order (MB artist first)
  target_url  text,                        -- the submission page to open
  intro       text,
  steps       jsonb not null default '[]'::jsonb,  -- [{key,label,value,note,optional,url}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Resumable progress: one row per wizard, the set of completed step keys.
create table if not exists public.listing_progress (
  wizard_key  text primary key,
  done_steps  text[] not null default '{}',
  updated_at  timestamptz not null default now()
);

alter table public.listing_wizards  enable row level security;
alter table public.listing_progress enable row level security;

create policy listing_wizards_owner_select  on public.listing_wizards  for select to authenticated using (public.is_parlor_owner());
create policy listing_progress_owner_select on public.listing_progress for select to authenticated using (public.is_parlor_owner());
create policy listing_progress_owner_insert on public.listing_progress for insert to authenticated with check (public.is_parlor_owner());
create policy listing_progress_owner_update on public.listing_progress for update to authenticated using (public.is_parlor_owner()) with check (public.is_parlor_owner());
