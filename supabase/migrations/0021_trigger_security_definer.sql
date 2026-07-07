-- Security fix: the execution-dispatch + bookkeeping-gate triggers read vault /
-- write the journal, but ran as INVOKER. A CLIENT (authenticated) action_queue write
-- fired them under a role with no `vault` access → "permission denied for schema vault",
-- which aborted the client's write. Make them SECURITY DEFINER (run as the owner, which
-- can read vault) with a fixed, safe search_path. No client ever touches vault; the
-- server-owned trigger does, on the client's behalf.
alter function public.dispatch_execution() security definer;
alter function public.dispatch_execution() set search_path = public, extensions, vault;
alter function public.reject_bookkeeping_queue() security definer;
alter function public.reject_bookkeeping_queue() set search_path = public, extensions, vault;
