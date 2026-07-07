import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import { useSilk } from '../SilkContext';
import { useToast } from '../components/Toast';

function startOfWeek() { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString(); }

const BUTTON_BY_KIND: Record<string, string> = {
  'bio-approval': 'Review the bio',
  'entity-submission': 'Open the listing kit',
  'corpus-page': 'Draft the page',
  'metadata-fix': 'See the fix',
  'revise-role': 'Review the changes',
};

interface Moment { id: string; kind: string; observation: string; proposal: string; button: string }

export default function Brief() {
  const { setRoom, setFocusNode, pointedNode, askSilk } = useSilk();
  const toast = useToast();
  const [runs, setRuns] = useState<any[] | null>(null);
  const [initiatives, setInitiatives] = useState(0);
  const [moment, setMoment] = useState<Moment | null>(null);
  const [sheet, setSheet] = useState(false);
  const [live, setLive] = useState(false);
  const [counters, setCounters] = useState({ followers: 0, followersCollected: false, mentions: 0, ai: 0 });

  const load = useCallback(async () => {
    const { data: r } = await supabase.from('visibility_runs').select('run_at, mentions_total, prompt_count, summary').order('run_at', { ascending: false }).limit(2);
    setRuns(r ?? []);
    const { data: j } = await supabase.from('silk_journal').select('entry').order('created_at', { ascending: false }).limit(1);
    const observation = j?.[0]?.entry ?? '';
    // Moment = highest-priority, non-snoozed proposed action → observation + proposal.
    const { data: acts } = await supabase.from('action_queue').select('id, kind, payload').eq('status', 'proposed').order('created_at', { ascending: false }).limit(8);
    const now = Date.now();
    const top = (acts ?? []).find((a: any) => !a.payload?.snoozed_until || Date.parse(a.payload.snoozed_until) < now);
    setMoment(top ? {
      id: top.id, kind: top.kind,
      observation: observation ? (observation.length > 180 ? observation.slice(0, 180) + '…' : observation) : 'Discovery lanes are still quiet — organic visibility is near zero.',
      proposal: top.payload?.rationale ?? 'Open this in the Workshop.',
      button: BUTTON_BY_KIND[top.kind] ?? 'Open in Workshop',
    } : null);
    const [fol, men, ai] = await Promise.all([
      supabase.from('metrics_snapshots').select('value').eq('metric', 'followers').order('captured_at', { ascending: false }).limit(1),
      supabase.from('mentions_ledger').select('id', { count: 'exact', head: true }).gte('found_at', startOfWeek()),
      supabase.from('site_visits').select('id', { count: 'exact', head: true }).eq('is_ai_referrer', true).gte('ts', startOfWeek()),
    ]);
    setCounters({ followers: Number(fol.data?.[0]?.value ?? 0), followersCollected: !!fol.data?.length, mentions: men.count ?? 0, ai: ai.count ?? 0 });
    // Overnight initiatives Silk queued (workshop_initiative).
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

  async function doIt() {
    if (!moment) return;
    const DRAFT_KINDS = new Set(['corpus-initiative', 'corpus-page']);
    const { data: row } = await supabase.from('action_queue').select('payload').eq('id', moment.id).single();
    const payload = row?.payload ?? {};
    // Draft-creation moments must actually create + verify the draft before approving.
    if (DRAFT_KINDS.has(moment.kind)) {
      try {
        const r = await callFn('foundry-generate', { target_query: String(payload.target_query ?? '') });
        if (!r?.ok || !r?.draft?.id) throw new Error(r?.error || 'no draft created');
        await supabase.from('action_queue').update({ status: 'approved', payload: { ...payload, decided_at: new Date().toISOString(), draft_id: r.draft.id, draft_created: true } }).eq('id', moment.id);
      } catch (e) {
        await supabase.from('action_queue').update({ payload: { ...payload, approval_error: e instanceof Error ? e.message : String(e) } }).eq('id', moment.id);
        setSheet(false); load(); return; // don't mark approved / navigate on failure
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
    const prev = data?.payload ?? {};
    await supabase.from('action_queue').update({ payload: { ...prev, snoozed_until: until } }).eq('id', moment.id);
    setSheet(false); load();
    toast('Snoozed a week', async () => { await supabase.from('action_queue').update({ payload: prev }).eq('id', moment.id); load(); });
  }
  function askAboutIt() { if (moment) { askSilk(`About your proposal — ${moment.proposal}`); setSheet(false); } }

  return (
    <div className="stack">
      <div className="brief-top">
        <div>
          <div className="eyebrow">Visibility {live && <span className="pulse" style={{ display: 'inline-block', marginLeft: 4 }} />}</div>
          <div className="score-big num">{latest.mentions_total}<span className="score-of">/{latest.prompt_count}</span></div>
        </div>
        {delta !== null && (
          <div className={`delta ${delta >= 0 ? 'up' : 'down'}`}>{delta > 0 ? `↑ ${delta}` : delta < 0 ? `↓ ${Math.abs(delta)}` : '— even'}<div className="muted small">vs last week</div></div>
        )}
      </div>

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

      {whatChanged.length > 0 && (
        <section>
          <h2>What changed</h2>
          <ul className="journal">{whatChanged.slice(0, 5).map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}

      <div className="brief-counters">
        <div className="bc">
          <div className="n num">{counters.followersCollected ? counters.followers : '—'}</div>
          <div className="muted small">followers</div>
          <div className="muted" style={{ fontSize: '0.68rem' }}>{counters.followersCollected ? 'this week' : 'Spotify pull pending'}</div>
        </div>
        <div className="bc">
          <div className="n num">{counters.mentions}</div>
          <div className="muted small">new mentions</div>
          <div className="muted" style={{ fontSize: '0.68rem' }}>{counters.mentions === 0 ? 'none yet — I scan public pages' : 'this week'}</div>
        </div>
        <div className="bc">
          <div className="n num">{counters.ai}</div>
          <div className="muted small">AI referrals</div>
          <div className="muted" style={{ fontSize: '0.68rem' }}>{counters.ai === 0 ? "waiting for first — I'll ping Discord" : 'this week'}</div>
        </div>
      </div>

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
