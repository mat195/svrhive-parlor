-- Hard write-path gate (enforced, not just doctrine): Mat's queue is DECISIONS ONLY.
-- Any action_queue INSERT that classifies as bookkeeping (sync file writes, cache
-- refreshes, deploy confirmations, runtime-to-file migrations) is rejected at the
-- infrastructure level and the intent is routed to silk_journal instead. This closes
-- the class where Silk kept filing doctrine-sync/bookkeeping items despite the rule.
create or replace function public.reject_bookkeeping_queue()
returns trigger language plpgsql as $$
declare k text := new.kind;
begin
  if k in ('doctrine-sync', 'config-sync', 'file-sync', 'sync', 'cache-refresh',
           'deploy-confirm', 'deploy-confirmation', 'backfill-confirm', 'runtime-sync')
     or coalesce((new.payload->>'bookkeeping')::boolean, false) is true then
    insert into public.silk_journal(entry, tags)
      values('[queue-gate] Bookkeeping auto-routed from Mat''s queue to the journal (write-path enforcement): '
               || coalesce(new.payload->>'doctrine_line', new.payload->>'title', new.kind),
             array['bookkeeping', 'queue-gate', 'auto-routed']);
    return null; -- cancels the action_queue INSERT
  end if;
  return new;
end $$;

drop trigger if exists trg_reject_bookkeeping on public.action_queue;
create trigger trg_reject_bookkeeping before insert on public.action_queue
  for each row execute function public.reject_bookkeeping_queue();
