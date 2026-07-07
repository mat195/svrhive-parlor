-- Skip on Question Cards: a real terminal state (was only decrementing urgency).
alter table public.silk_questions drop constraint if exists silk_questions_status_check;
alter table public.silk_questions add constraint silk_questions_status_check
  check (status in ('pending', 'open', 'answered', 'dismissed', 'skipped'));

alter table public.silk_questions add column if not exists skipped_at timestamptz;
alter table public.silk_questions add column if not exists skip_reason text;

-- Owner may write journal entries from the client (skip-reason telemetry, presence
-- cleanup). Journals stay owner-private; only Mat's JWT satisfies is_parlor_owner().
drop policy if exists silk_journal_owner_insert on public.silk_journal;
create policy silk_journal_owner_insert on public.silk_journal for insert to authenticated with check (public.is_parlor_owner());
