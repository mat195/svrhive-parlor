import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

type Relevance = 'fit' | 'maybe' | 'not_eligible';
interface Grant {
  id: string;
  funder: string;
  program_name: string;
  deadline: string | null;
  deadline_note: string | null;
  eligibility_summary: string | null;
  funding_min: number | null;
  funding_max: number | null;
  funding_note: string | null;
  application_url: string | null;
  relevance: Relevance;
  relevance_note: string | null;
  recurring_annual: boolean;
  source_url: string;
  source_excerpt: string | null;
  fetched_at: string;
}

const REL_META: Record<Relevance, { dot: string; label: string }> = {
  fit: { dot: 'risk-green', label: 'Clear fit' },
  maybe: { dot: 'risk-amber', label: 'Maybe — worth a look' },
  not_eligible: { dot: 'risk-grey', label: 'Not eligible' },
};

const money = (n: number) => `$${n.toLocaleString('en-CA')}`;
function fundingText(g: Grant): string | null {
  if (g.funding_note) return g.funding_note;
  if (g.funding_min != null && g.funding_max != null) return g.funding_min === g.funding_max ? money(g.funding_max) : `${money(g.funding_min)}–${money(g.funding_max)}`;
  if (g.funding_max != null) return `up to ${money(g.funding_max)}`;
  if (g.funding_min != null) return `from ${money(g.funding_min)}`;
  return null;
}

// Soonest-first: real dates ascending, then rolling/undated last.
function byDeadline(a: Grant, b: Grant): number {
  if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline);
  if (a.deadline) return -1;
  if (b.deadline) return 1;
  return a.funder.localeCompare(b.funder);
}

function deadlineLabel(g: Grant): { text: string; tone: 'soon' | 'ok' | 'past' | 'rolling' } {
  if (!g.deadline) return { text: g.deadline_note?.trim() || 'Rolling / varies', tone: 'rolling' };
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(g.deadline + 'T00:00:00');
  const days = Math.round((d.getTime() - today.getTime()) / 864e5);
  const nice = d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  if (days < 0) return { text: `${nice} · passed`, tone: 'past' };
  if (days === 0) return { text: `${nice} · today`, tone: 'soon' };
  return { text: `${nice} · in ${days} day${days === 1 ? '' : 's'}`, tone: days <= 30 ? 'soon' : 'ok' };
}

type Filter = 'relevant' | 'fit' | 'maybe' | 'all';

export default function GrantOpportunities() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [filter, setFilter] = useState<Filter>('relevant');

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from('grant_opportunities')
        .select('*')
        .eq('status', 'active');
      setGrants(((data as Grant[]) ?? []).slice().sort(byDeadline));
    })();
  }, []);

  const lastUpdated = useMemo(() => {
    if (!grants?.length) return null;
    return grants.map((g) => g.fetched_at).sort().at(-1) ?? null;
  }, [grants]);

  if (!grants) return <p className="muted">Loading…</p>;

  const counts = {
    fit: grants.filter((g) => g.relevance === 'fit').length,
    maybe: grants.filter((g) => g.relevance === 'maybe').length,
    all: grants.length,
  };
  const shown = grants.filter((g) =>
    filter === 'all' ? true
      : filter === 'relevant' ? g.relevance !== 'not_eligible'
        : g.relevance === filter,
  );

  return (
    <div className="stack">
      <p className="eyebrow">Opportunity Finder</p>
      <h2 style={{ margin: '0 0 0.2rem' }}>Grant Opportunities</h2>

      {/* Informational-only contract — this surface never applies to anything. */}
      <div className="live-banner">
        <strong>Informational only.</strong> Silk scans Canadian arts funders weekly and flags whether you
        plausibly qualify. Nothing here applies to anything automatically — grant applications need real
        writing and judgment. Review, then decide what to pursue.
      </div>

      <div className="subtabs">
        <button className={filter === 'relevant' ? 'chip active' : 'chip'} onClick={() => setFilter('relevant')}>Relevant ({counts.fit + counts.maybe})</button>
        <button className={filter === 'fit' ? 'chip active' : 'chip'} onClick={() => setFilter('fit')}><span className="risk-dot risk-green" /> Fits ({counts.fit})</button>
        <button className={filter === 'maybe' ? 'chip active' : 'chip'} onClick={() => setFilter('maybe')}><span className="risk-dot risk-amber" /> Maybes ({counts.maybe})</button>
        <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>All ({counts.all})</button>
      </div>

      {shown.length === 0 ? (
        <p className="empty">
          {grants.length === 0
            ? 'No opportunities harvested yet. The scout runs every Monday (FACTOR, Musicaction, SOCAN Foundation, CALQ, Canada Council).'
            : 'Nothing in this view.'}
        </p>
      ) : (
        shown.map((g) => {
          const dl = deadlineLabel(g);
          const rm = REL_META[g.relevance];
          const funding = fundingText(g);
          return (
            <div className={`card grant rel-${g.relevance}`} key={g.id}>
              <div className="row-head">
                <span className={`risk-dot ${rm.dot}`} title={rm.label} />
                <span className="pill">{g.funder}</span>
                {g.recurring_annual && <span className="chip small" title="Runs on a repeating annual cycle">annual</span>}
                <span className={`grant-deadline tone-${dl.tone}`} style={{ marginLeft: 'auto', fontWeight: 600 }}>{dl.text}</span>
              </div>

              <div className="row-title" style={{ fontWeight: 600, margin: '0.35rem 0 0.15rem' }}>{g.program_name}</div>
              <div className={`grant-rel rel-${g.relevance}`} style={{ fontSize: '0.86rem' }}>
                {rm.label}{g.relevance_note ? ` — ${g.relevance_note}` : ''}
              </div>

              {g.eligibility_summary && <p className="muted small" style={{ margin: '0.5rem 0 0' }}>{g.eligibility_summary}</p>}
              {funding && <p className="small" style={{ margin: '0.3rem 0 0' }}><strong>Funding:</strong> {funding}</p>}

              <div className="row" style={{ gap: '0.6rem', alignItems: 'center', marginTop: '0.6rem' }}>
                {g.application_url && <a className="btn sm" href={g.application_url} target="_blank" rel="noopener">View program ↗</a>}
                {g.source_excerpt && (
                  <details className="rationale-x">
                    <summary>Source</summary>
                    <p className="rationale">“{g.source_excerpt}”<br /><a className="link small" href={g.source_url} target="_blank" rel="noopener">{g.source_url}</a></p>
                  </details>
                )}
              </div>
            </div>
          );
        })
      )}

      {/* Deliberate scope note — the brief asked to flag this limitation in the UI rather
          than pretend coverage exists. */}
      <details className="rationale-x" style={{ marginTop: '0.4rem' }}>
        <summary className="muted small">What this doesn't cover</summary>
        <p className="rationale muted small">
          The scout covers structured grant programs only. It deliberately does <strong>not</strong> monitor social media,
          X/Twitter, Reddit, Instagram, or informal feature-marketplace sites for “artists selling features” or feature
          requests — no reliable API exists for those, they're hostile to scraping, and a fragile scraper that silently
          fails would be worse than none. If that channel matters, it needs a human eye, not automation.
        </p>
      </details>

      {lastUpdated && <p className="muted small">Last scanned {new Date(lastUpdated).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })} · refreshes weekly.</p>}
    </div>
  );
}
