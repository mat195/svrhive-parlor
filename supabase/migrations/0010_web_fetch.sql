-- Brief Five — web-fetch research infrastructure. Silk reads public data at scale
-- so Mat never pastes it. Cache (24h TTL) + full audit log. Owner-read (RLS);
-- writes via the service-role Edge Function.

create table if not exists public.web_fetch_cache (
  url          text primary key,
  status       int,
  headers      jsonb not null default '{}'::jsonb,
  body         text,
  fetched_at   timestamptz not null default now(),
  ttl_seconds  int not null default 86400
);
create index if not exists idx_web_fetch_cache_fetched on public.web_fetch_cache (fetched_at desc);

-- Every fetch is auditable, always.
create table if not exists public.web_fetches (
  id            uuid primary key default gen_random_uuid(),
  url           text not null,
  host          text,
  requested_at  timestamptz not null default now(),
  status        int,
  from_cache    boolean not null default false
);
create index if not exists idx_web_fetches_host on public.web_fetches (host, requested_at desc);
create index if not exists idx_web_fetches_requested on public.web_fetches (requested_at desc);

alter table public.web_fetch_cache enable row level security;
alter table public.web_fetches     enable row level security;
create policy web_fetch_cache_owner_select on public.web_fetch_cache for select to authenticated using (public.is_parlor_owner());
create policy web_fetches_owner_select     on public.web_fetches     for select to authenticated using (public.is_parlor_owner());
