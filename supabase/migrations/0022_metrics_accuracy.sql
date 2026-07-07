-- Metrics accuracy: (1) schedule the daily Spotify metrics pull, (2) reconcile
-- citations-vs-mentions over the visibility battery data.

-- ── 1) Daily Spotify metrics pull ────────────────────────────────────────────
-- Invoke spotify-metrics once a day (07:10 UTC). Keys read from Vault, matching the
-- existing dispatch pattern; nothing secret lives in the repo.
select cron.schedule(
  'spotify_metrics_daily',
  '10 7 * * *',
  $$
  select net.http_post(
    url := 'https://fitpvesrrirezbndkelo.supabase.co/functions/v1/spotify-metrics',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'anon_key'),
      'x-cron-key', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_key')
    ),
    body := '{}'::jsonb
  );
  $$
);

-- ── 2) Citations-vs-mentions reconciliation ──────────────────────────────────
-- Every visibility_results cell records whether LPT was NAMED (mentioned) and which
-- source URLs the engine CITED. These were never reconciled: engines can name him with
-- zero owned-source citations, or cite pages that never mention him. Surface both.

-- Owner-only view: one row per cited domain, with owned-vs-third-party classification.
-- security_invoker → the caller's RLS on visibility_results applies (owner-only).
create or replace view public.visibility_citation_rollup
with (security_invoker = true) as
with cited as (
  select
    vr.run_id,
    vr.engine,
    vr.mentioned,
    lower(regexp_replace(c.url, '^https?://(www\.)?([^/]+).*$', '\2')) as domain,
    c.url
  from public.visibility_results vr
  cross join lateral jsonb_array_elements_text(vr.citations) as c(url)
  where jsonb_typeof(vr.citations) = 'array'
)
select
  domain,
  count(*)                                   as times_cited,
  count(distinct run_id)                     as runs_seen,
  count(distinct engine)                     as engines_citing,
  count(*) filter (where mentioned)          as cited_when_named,
  bool_or(
    domain like '%silkvelvetrecords.com'
    or domain = 'open.spotify.com'
    or domain like '%luciuspthundercat%'
  )                                          as is_owned
from cited
group by domain
order by times_cited desc;

-- Reconciliation summary Silk can query directly (SECURITY DEFINER so the tool loop can
-- read it without owner JWT; returns aggregates only, no private data).
create or replace function public.citation_reconciliation()
returns jsonb language sql security definer set search_path = public as $$
  with base as (
    select
      count(*)                                   as cells,
      count(*) filter (where mentioned)          as name_mentions,
      count(*) filter (where jsonb_array_length(citations) > 0) as cells_with_citations
    from public.visibility_results
  ),
  dom as (
    select
      count(distinct domain)                                  as distinct_domains,
      count(distinct domain) filter (where is_owned)          as owned_domains_cited,
      sum(times_cited) filter (where is_owned)                as owned_citation_hits,
      sum(times_cited)                                        as total_citation_hits
    from public.visibility_citation_rollup
  ),
  toplist as (
    select jsonb_agg(jsonb_build_object('domain', domain, 'times_cited', times_cited) order by times_cited desc) as top
    from (select domain, times_cited from public.visibility_citation_rollup order by times_cited desc limit 10) t
  )
  select jsonb_build_object(
    'cells', base.cells,
    'name_mentions', base.name_mentions,
    'cells_with_citations', base.cells_with_citations,
    'distinct_domains_cited', dom.distinct_domains,
    'owned_domains_cited', dom.owned_domains_cited,
    'owned_citation_hits', coalesce(dom.owned_citation_hits, 0),
    'total_citation_hits', coalesce(dom.total_citation_hits, 0),
    'top_cited_domains', coalesce(toplist.top, '[]'::jsonb)
  )
  from base, dom, toplist;
$$;

grant execute on function public.citation_reconciliation() to authenticated, service_role;
