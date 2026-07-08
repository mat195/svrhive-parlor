-- Real lifetime stream counts on release records (source: Spotify for Artists songs
-- export). Lets corpus builders / playlist pages pick tracks by real popularity instead
-- of guessing, and gives every "notable release" claim a sourced number.
alter table public.releases add column if not exists streams bigint;
alter table public.releases add column if not exists streams_as_of date;
comment on column public.releases.streams is 'Lifetime stream count, source: Spotify for Artists songs export. Null = not yet reconciled from the CSV.';
