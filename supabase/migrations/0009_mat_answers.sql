-- Brief Five addendum — Silk learns from answers. Append-only ledger of every
-- answer Mat gives, so answers become teaching moments, not row updates.
create table if not exists public.mat_answers (
  id                           uuid primary key default gen_random_uuid(),
  created_at                   timestamptz not null default now(),
  question_id                  uuid references public.silk_questions(id) on delete set null,
  question_text                text,
  answer_text                  text,
  entity_master_field_touched  text,
  propagation_status           text not null default 'pending' check (propagation_status in ('pending', 'complete')),
  journal_ref                  uuid references public.silk_journal(id) on delete set null
);
create index if not exists idx_mat_answers_created on public.mat_answers (created_at desc);

alter table public.mat_answers enable row level security;
create policy mat_answers_owner_select on public.mat_answers for select to authenticated using (public.is_parlor_owner());
