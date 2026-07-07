-- RLS discipline (Brief Seven): reconcile repo ↔ live. These owner-select policies
-- existed in the live DB but were added out-of-band and never captured in a
-- migration — the exact drift the RLS check guards against. Declared here (literal,
-- so check-rls sees them) as source-of-truth. Idempotent. All are server-authored,
-- owner-read tables (service role writes; Mat reads via the Parlor).
drop policy if exists visibility_runs_owner_select on public.visibility_runs;
create policy visibility_runs_owner_select on public.visibility_runs for select to authenticated using (public.is_parlor_owner());

drop policy if exists visibility_results_owner_select on public.visibility_results;
create policy visibility_results_owner_select on public.visibility_results for select to authenticated using (public.is_parlor_owner());

drop policy if exists entity_facts_owner_select on public.entity_facts;
create policy entity_facts_owner_select on public.entity_facts for select to authenticated using (public.is_parlor_owner());

drop policy if exists link_graph_owner_select on public.link_graph;
create policy link_graph_owner_select on public.link_graph for select to authenticated using (public.is_parlor_owner());

drop policy if exists releases_owner_select on public.releases;
create policy releases_owner_select on public.releases for select to authenticated using (public.is_parlor_owner());

drop policy if exists tracks_owner_select on public.tracks;
create policy tracks_owner_select on public.tracks for select to authenticated using (public.is_parlor_owner());

drop policy if exists mentions_ledger_owner_select on public.mentions_ledger;
create policy mentions_ledger_owner_select on public.mentions_ledger for select to authenticated using (public.is_parlor_owner());

drop policy if exists metrics_snapshots_owner_select on public.metrics_snapshots;
create policy metrics_snapshots_owner_select on public.metrics_snapshots for select to authenticated using (public.is_parlor_owner());

drop policy if exists drafts_owner_select on public.drafts;
create policy drafts_owner_select on public.drafts for select to authenticated using (public.is_parlor_owner());
