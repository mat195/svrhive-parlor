-- Tier model on the raw catalog tables, mirroring skill:catalog-tier-model and §6, so any
-- consumer of releases/tracks (submission kits, corpus builders, anything querying raw
-- catalog) can filter out withdrawn / non-surfaceable entries AUTOMATICALLY — instead of
-- relying on someone cross-checking §6 by hand.
--   tier 1 = DSP-active · 2 = strategic non-DSP · 3 = uncleared-sample SoundCloud-only ·
--   4 = DSP-released-then-withdrawn.
alter table public.releases add column if not exists tier smallint not null default 1;
alter table public.releases add column if not exists tier_history jsonb not null default '[]'::jsonb;
alter table public.tracks   add column if not exists tier smallint not null default 1;
comment on column public.releases.tier is '1=DSP-active,2=strategic non-DSP,3=uncleared-sample SoundCloud-only,4=DSP-released-then-withdrawn (skill:catalog-tier-model). Only tier 1 is surfaceable publicly.';
comment on column public.tracks.tier   is 'mirrors releases.tier for direct filtering';

-- Foolproof consumers: query the *_surfaceable views instead of remembering a WHERE clause.
-- security_invoker → the caller''s owner-only RLS on the base table still applies.
create or replace view public.releases_surfaceable with (security_invoker = true) as
  select * from public.releases where tier = 1;
create or replace view public.tracks_surfaceable with (security_invoker = true) as
  select * from public.tracks where tier = 1;

-- Existing catalog = the DSP-live Spotify backfill → tier 1 (matches the column default;
-- explicit for clarity / idempotency).
update public.releases set tier = 1 where tier is null;
update public.tracks   set tier = 1 where tier is null;
