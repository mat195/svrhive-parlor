-- Question provenance + 'pending' status + runtime identity config.
alter table public.silk_questions add column if not exists generated_by text;

-- Allow 'pending' (the renderable state used by question_hunter + the Strip).
alter table public.silk_questions drop constraint if exists silk_questions_status_check;
alter table public.silk_questions add constraint silk_questions_status_check
  check (status in ('pending', 'open', 'answered', 'dismissed'));

-- silk_config: current SILK_IDENTITY.md (+ hash) loaded into every Silk LLM call
-- at runtime, so doctrine edits land without redeploying functions.
create table if not exists public.silk_config (
  key         text primary key,
  value       text,
  hash        text,
  updated_at  timestamptz not null default now()
);
alter table public.silk_config enable row level security;
create policy silk_config_owner_select on public.silk_config for select to authenticated using (public.is_parlor_owner());
