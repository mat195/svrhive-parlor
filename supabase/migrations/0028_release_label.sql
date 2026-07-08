-- Real label-data source for the §2 "does this release carry Silk Velvet Records as
-- label" question. Persist DSP label metadata onto each release (fetched from Spotify by
-- UPC/ISRC — targeted lookups, not fragile artist-album enumeration). The §2 audit then
-- reads from the DB instead of guessing.
alter table public.releases add column if not exists label text;
alter table public.releases add column if not exists copyright text;
alter table public.releases add column if not exists spotify_album_id text;
alter table public.releases add column if not exists label_checked_at timestamptz;
comment on column public.releases.label is 'DSP label field (Spotify album.label). Source of truth for §2 label-association.';
