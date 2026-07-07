-- Item 5 (Ledger→Workshop bridge) files proposals from the client. action_queue had
-- only SELECT+UPDATE for the owner — add owner INSERT so client-filed proposals land
-- (else the write silently RLS-fails). The bookkeeping BEFORE-INSERT gate still applies.
drop policy if exists action_queue_owner_insert on public.action_queue;
create policy action_queue_owner_insert on public.action_queue for insert to authenticated with check (public.is_parlor_owner());
