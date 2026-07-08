import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import { useSilk } from '../SilkContext';
import { useToast } from '../components/Toast';
import AudienceChart from '../components/AudienceChart';

function startOfWeek() { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString(); }

const BUTTON_BY_KIND: Record<string, string> = {
  'bio-approval': 'Review the bio',
  'entity-submission': 'Open the listing kit',
  'corpus-page': 'Draft the page',
  'metadata-fix': 'See the fix',
  'revise-role': 'Review the changes',
};

interface Moment { id: string; kind: string; observation: string; proposal: string; button: string }
interface SysIssue { id: string; tone: 'error' | 'wait'; summary: string; detail: string; canDismiss: boolean }

// Trend arrow vs last week. null = no comparison yet.
function Trend({ d }: { d: number | null }) {
  if (d === null) return null;
  const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  return <span className={`trend ${dir}`} title={`${d > 0 ? '+' : ''}${d} vs last week`}>{d > 0 ? '↑' : d < 0 ? '↓' : '→'}</span>;
}

// Map a stuck/failed/pending queue item to a plain-English system-health line.
function toIssue(a: any): SysIssue | null {
  const p = a.payload ?? {};
  if (p.execution_error || p.execution_giveup) {
    const err = String(p.execution_error ?? '');
    const summary = err.includes('no target_query')
      ? 'A draft-page task can’t run — it has no query to write about (its draft was removed).'
      : err.includes('owner token')
        ? 'A task couldn’t authenticate to run itself.'
        : 'A queued action hit an error while running and was held back.';
    return { id: a.id, tone: 'error', summary, detail: err || 'unknown error', canDismiss: true };
  }
  if (p.awaiting_site) {
    return { id: a.id, tone: 'wait', summary: 'A correction is recorded but not yet confirmed live on the site.', detail: String(p.execution_note ?? ''), canDismiss: false };
  }
  return null;
}

export default function Brief() {
  const { setRoom, setFocusNode, pointedNode, askSilk } = useSilk();
  const toast = useToast();
  const [runs, setRuns] = useState<any[] | null>(null);
  const [initiatives, setInitiatives] = useState(0);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [sheet, setSheet] = useState(false);
  const [live, setLive] = useState(false);
  const [counters, setCounters] = useState({ followers: 0, followersCollected: false, followersTrend: null as number | null, monthly: 0, monthlyCollected: false, monthlyTrend: null as number | null, mentions: 0, ai: 0 });
  const [issues, setIssues] = useState<SysIssue[]>([]);
  const [sysOpen, setSysOpen] = useState<boolean | null>(null); // null = follow issue presence; boolean = user's choice

  const load = useCallback(async () => {
    const { data: r } = await supabase.from('visibility_runs').select('run_at, mentions_total, prompt_count, summary').order('run_at', { ascending: false }).limit(2);
    setRuns(r ?? []);
    const { data: j } = await supabase.from('silk_journal').select('entry').order('created_at', { ascending: false }).limit(1);
    const observation = j?.[0]?.entry ?? '';
    const { data: acts } = await supabase.from('action_queue').select('id, kind, payload').eq('status', 'proposed').order('created_at', { ascending: false }).limit(8);
    const now = Date.now();
    const top = (acts ?? []).find((a: any) => !a.payload?.snoozed_until || Date.parse(a.payload.snoozed_until) < now);
    setMoment(top ? {
      id: top.id, kind: top.kind,
      observation: observation ? (observation.length > 180 ? observation.slice(0, 180) + '…' : observation) : 'Discovery lanes are still quiet — organic visibility is near zero.',
      proposal: top.payload?.rationale ?? 'Open this in the Workshop.',
      button: BUTTON_BY_KIND[top.kind] ?? 'Open in Workshop',
    } : null);
    // Two latest snapshots each → current value + week-over-week trend.
    const [fol, ml, men, ai, sys] = await Promise.all([
      supabase.from('metrics_snapshots').select('value').eq('metric', 'followers').order('captured_at', { ascending: false }).limit(2),
      supabase.from('metrics_snapshots').select('value').eq('metric', 'monthly_listeners').order('captured_at', { ascending: false }).limit(2),
      supabase.from('mentions_ledger').select('id', { count: 'exact', head: true }).gte('found_at', startOfWeek()),
      supabase.from('site_visits').select('id', { count: 'exact', head: true }).eq('is_ai_referrer', true).gte('ts', startOfWeek()),
      supabase.from('action_queue').select('id, kind, payload').eq('status', 'approved').limit(50),
    ]);
    const trend = (rows: any[] | null) => (rows && rows.length >= 2 ? Number(rows[0].value) - Number(rows[1].value) : null);
    setCounters({
      followers: Number(fol.data?.[0]?.value ?? 0), followersCollected: !!fol.data?.length, followersTrend: trend(fol.data),
      monthly: Number(ml.data?.[0]?.value ?? 0), monthlyCollected: !!ml.data?.length, monthlyTrend: trend(ml.data),
      mentions: men.count ?? 0, ai: ai.count ?? 0,
    });
    setIssues((sys.data ?? []).map(toIssue).filter(Boolean) as SysIssue[]);
    const init = await supabase.from('action_queue').select('id', { count: 'exact', head: true }).eq('status', 'proposed').eq('payload->>generated_by', 'workshop_initiative');
    setInitiatives(init.count ?? 0);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel('brief-live')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'visibility_runs' }, () => { setLive(true); load(); setTimeout(() => setLive(false), 4000); })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'site_visits' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  if (!runs) return <p className="muted">Loading…</p>;
  if (runs.length === 0) return <div className="silk-hint">No battery runs yet. Ask me to explain what we're measuring.</div>;

  const [latest, prev] = runs;
  const delta = prev ? latest.mentions_total - prev.mentions_total : null;
  const whatChanged: string[] = latest.summary?.whatChanged ?? [];
  const goBrain = (node: string) => { setFocusNode(node); setRoom('brain'); };
  const sysExpanded = sysOpen ?? issues.length > 0; // auto-expand only when something's wrong

  async function dismissIssue(id: string) {
    const { data } = await supabase.from('action_queue').select('payload').eq('id', id).single();
    const prevPayload = data?.payload ?? {};
    await supabase.from('action_queue').update({ status: 'rejected', payload: { ...prevPayload, dismissed_at: new Date().toISOString(), dismissed_from: 'brief' } }).eq('id', id);
    load();
    toast('Issue dismissed', async () => { await supabase.from('action_queue').update({ status: 'approved', payload: prevPayload }).eq('id', id); load(); });
  }

  async function doIt() {
    if (!moment) return;
    const DRAFT_KINDS = new Set(['corpus-initiative', 'corpus-page']);
    const { data: row } = await supabase.from('action_queue').select('payload').eq('id', moment.id).single();
    const payload = row?.payload ?? {};
    if (DRAFT_KINDS.has(moment.kind)) {
      try {
        const r = await callFn('foundry-generate', { target_query: String(payload.target_query ?? '') });
        if (!r?.ok || !r?.draft?.id) throw new Error(r?.error || 'no draft created');
        await supabase.from('action_queue').update({ status: 'approved', payload: { ...payload, decided_at: new Date().toISOString(), draft_id: r.draft.id, draft_created: true } }).eq('id', moment.id);
      } catch (e) {
        await supabase.from('action_queue').update({ payload: { ...payload, approval_error: e instanceof Error ? e.message : String(e) } }).eq('id', moment.id);
        setSheet(false); load(); return;
      }
    } else {
      await supabase.from('action_queue').update({ status: 'approved', payload: { ...payload, decided_at: new Date().toISOString(), acting: true } }).eq('id', moment.id);
    }
    await supabase.from('silk_journal').insert({ entry: `Mat approved: ${moment.button} — ${moment.proposal.slice(0, 120)}`, tags: ['moment', 'decision'] });
    setSheet(false); setRoom('workshop'); load();
  }
  async function notNow() {
    if (!moment) return;
    const until = new Date(Date.now() + 7 * 864e5).toISOString();
    const { data } = await supabase.from('action_queue').select('payload').eq('id', moment.id).single();
    const prevP = data?.payload ?? {};
    await supabase.from('action_queue').update({ payload: { ...prevP, snoozed_until: until } }).eq('id', moment.id);
    setSheet(false); load();
    toast('Snoozed a week', async () => { await supabase.from('action_queue').update({ payload: prevP }).eq('id', moment.id); load(); });
  }
  function askAboutIt() { if (moment) { askSilk(`About your proposal — ${moment.proposal}`); setSheet(false); } }

  return (
    <div className="stack">
      {/* ───────── ZONE 1 — IS IT WORKING? (campaign health) ───────── */}
      <section className="zone zone-campaign">
        <div className="zone-tag">Is it working?</div>

        <div className="brief-top">
          <div>
            <div className="eyebrow">Visibility {live && <span className="pulse" style={{ display: 'inline-block', marginLeft: 4 }} />}</div>
            <div className="score-big num">{latest.mentions_total}<span className="score-of">/{latest.prompt_count}</span></div>
          </div>
          {delta !== null && (
            <div className={`delta ${delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}`}>{delta > 0 ? `↑ ${delta}` : delta < 0 ? `↓ ${Math.abs(delta)}` : '→ even'}<div className="muted small">vs last week</div></div>
          )}
        </div>

        {whatChanged.length > 0 && (
          <ul className="journal" style={{ marginTop: '0.2rem' }}>{whatChanged.slice(0, 5).map((c, i) => <li key={i}>{c}</li>)}</ul>
        )}

        <div className="brief-counters">
          <div className="bc">
            <div className="n num">{counters.monthlyCollected ? counters.monthly.toLocaleString() : '—'} <Trend d={counters.monthlyTrend} /></div>
            <div className="muted small">monthly listeners</div>
            <div className="muted" style={{ fontSize: '0.68rem' }}>{counters.monthlyCollected ? 'Spotify · current' : 'no pull yet'}</div>
          </div>
          <div className="bc">
            <div className="n num">{counters.followersCollected ? counters.followers.toLocaleString() : '—'} <Trend d={counters.followersTrend} /></div>
            <div className="muted small">followers</div>
            <div className="muted" style={{ fontSize: '0.68rem' }}>{counters.followersCollected ? 'Spotify · current' : 'no pull yet'}</div>
          </div>
          <div className="bc">
            <div className="n num">{counters.ai}</div>
            <div className="muted small">AI referrals</div>
            <div className="muted" style={{ fontSize: '0.68rem' }}>{counters.ai === 0 ? '0 so far' : 'this week'}</div>
          </div>
        </div>

        {counters.ai === 0 && (
          <div className="ai-explainer">
            <strong>No AI referrals yet — and that's expected this early.</strong> This counts someone <em>clicking through</em> to the site from an AI answer (ChatGPT, Perplexity, Google AI). Getting <em>cited</em> by those engines comes first; the clicks follow. Right now we're still earning the citations — the moment one arrives, it shows here and I'll ping Discord.
          </div>
        )}

        {initiatives > 0 && (
          <button className="morning-card" onClick={() => { localStorage.setItem('workshop_tab', 'actions'); localStorage.setItem('workshop_filter', 'initiatives'); setRoom('workshop'); }}>
            <span className="morning-dot">◆</span>
            <span>Silk queued <strong>{initiatives}</strong> proposal{initiatives > 1 ? 's' : ''} for you overnight — review in Workshop →</span>
          </button>
        )}

        <div className="brainmini" role="group" aria-label="Brain preview">
          <button className={`node lpt ${pointedNode === 'lpt' ? 'pulse-point' : ''}`} style={{ left: '26%', top: '30%', width: 78, height: 78 }} onClick={() => goBrain('lpt')}>Lucius P.<br />Thundercat</button>
          <button className={`node svr ${pointedNode === 'svr' ? 'pulse-point' : ''}`} style={{ left: '62%', top: '42%', width: 56, height: 56 }} onClick={() => goBrain('svr')}>Silk Velvet</button>
          <span className="muted small" style={{ position: 'absolute', left: '10%', top: '78%' }}>catalog · collaborators · platforms →</span>
        </div>

        {moment && (
          <div className="moment">
            <div className="moment-label">Observation</div>
            <div className="said">{moment.observation}</div>
            <div className="moment-label" style={{ marginTop: '0.7rem' }}>Silk proposes</div>
            <p style={{ margin: '0.2rem 0 0' }}>{moment.proposal}</p>
            <button className="btn sm" style={{ marginTop: '0.7rem' }} onClick={() => setSheet(true)}>{moment.button} →</button>
          </div>
        )}

        <AudienceChart />
      </section>

      {/* ───────── ZONE 2 — IS THE MACHINE HEALTHY? (system status) ───────── */}
      <section className="zone zone-health">
        <button className="sys-summary" onClick={() => setSysOpen(!sysExpanded)} aria-expanded={sysExpanded}>
          <span className={`sys-dot ${issues.length ? 'bad' : 'ok'}`} />
          <span className="sys-title">System status</span>
          <span className="muted small sys-line">{issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''} need${issues.length > 1 ? '' : 's'} attention` : 'All systems normal'}</span>
          <span className="chev">{sysExpanded ? '▾' : '▸'}</span>
        </button>
        {sysExpanded && (
          <div className="sys-body">
            {issues.length === 0
              ? <p className="muted small" style={{ margin: '0.5rem 0 0' }}>Execution, jobs, and gates are all clear. Nothing needs you here.</p>
              : issues.map((it) => (
                <div className={`sys-issue ${it.tone}`} key={it.id}>
                  <div className="sys-issue-main">
                    <span className={`sys-dot ${it.tone === 'error' ? 'bad' : 'warn'}`} />
                    <span>{it.summary}</span>
                  </div>
                  <div className="sys-issue-actions">
                    <button className="link small" onClick={() => { localStorage.setItem('workshop_tab', 'actions'); setRoom('workshop'); }}>Details →</button>
                    {it.canDismiss && <button className="link small" onClick={() => dismissIssue(it.id)}>Dismiss</button>}
                  </div>
                  {it.detail && <details className="rationale-x"><summary>raw error</summary><p className="rationale mono" style={{ fontSize: '0.72rem' }}>{it.detail}</p></details>}
                </div>
              ))}
          </div>
        )}
      </section>

      {sheet && moment && (
        <div className="modal-backdrop" onClick={() => setSheet(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="moment-label">Silk proposes</div>
            <p style={{ marginTop: '0.3rem' }}>{moment.proposal}</p>
            <div className="actions" style={{ flexDirection: 'column' }}>
              <button className="btn" onClick={doIt}>{moment.button}</button>
              <button className="btn ghost" onClick={notNow}>Not now (snooze a week)</button>
              <button className="btn ghost" onClick={askAboutIt}>Ask Silk about this</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
