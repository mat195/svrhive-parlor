-- Signature element: stamped catalog numbers (SVR-NNN) by chronological order — the
-- label's real chronology as structure-as-information. Plus a cover_art registry.
alter table public.releases add column if not exists catalog_number text;

create table if not exists public.cover_art (
  id          uuid primary key default gen_random_uuid(),
  release_id  uuid references public.releases(id) on delete cascade,
  slug        text not null,
  local_path  text,
  source_url  text,
  fetched_at  timestamptz not null default now()
);
alter table public.cover_art enable row level security;
drop policy if exists cover_art_owner on public.cover_art;
create policy cover_art_owner on public.cover_art for select to authenticated using (public.is_parlor_owner());
