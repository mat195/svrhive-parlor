-- Persist each run's derived summary (competitors, cited domains, per-category /
-- per-engine breakdown) so the Parlor morning brief can render it directly from
-- the ledger instead of parsing report markdown.
alter table public.visibility_runs
  add column if not exists summary jsonb not null default '{}'::jsonb;
