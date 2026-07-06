-- Brief Four — Realtime: the room breathes. Add the tables the Brain/Brief watch
-- to the supabase_realtime publication. RLS still governs delivery (owner only).
do $$
begin
  alter publication supabase_realtime add table public.visibility_runs;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.silk_journal;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.site_visits;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table public.corpus_drafts;
exception when duplicate_object then null; end $$;
