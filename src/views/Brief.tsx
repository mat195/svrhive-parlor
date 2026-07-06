import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';

function startOfWeek() { const d = new Date(); d.setDate(d.getDate() - 7); return d.toISOString(); }

export default function Brief() {
  const { setRoom, setFocusNode, pointedNode } = useSilk();
  const [runs, setRuns] = useState<any[] | null>(null);
  const [moment, setMoment] = useState<string>('');
  const [counters, setCounters] = useState({ followers: 0, mentions: 0, ai: 0 });

  useEffect(() => {
    (async () => {
      const { data: r } = await supabase.from('visibility_runs').select('run_at, mentions_total, prompt_count, summary').order('run_at', { ascending: false }).limit(2);
      setRuns(r ?? []);
      const { data: j } = await supabase.from('silk_journal').select('entry').order('created_at', { ascending: false }).limit(1);
      setMoment(j?.[0]?.entry ?? '');
      const [fol, men, ai] = await Promise.all([
        supabase.from('metrics_snapshots').select('value').eq('metric', 'followers').order('captured_at', { ascending: false }).limit(1),
        supabase.from('mentions_ledger').select('id', { count: 'exact', head: true }).gte('found_at', startOfWeek()),
        supabase.from('site_visits').select('id', { count: 'exact', head: true }).eq('is_ai_referrer', true).gte('ts', startOfWeek()),
      ]);
      setCounters({ followers: Number(fol.data?.[0]?.value ?? 0), mentions: men.count ?? 0, ai: ai.count ?? 0 });
    })();
  }, []);

  if (!runs) return <p className="muted">Loading…</p>;
  if (runs.length === 0) return <div className="silk-hint">No battery runs yet. Ask me to explain what we're measuring.</div>;

  const [latest, prev] = runs;
  const delta = prev ? latest.mentions_total - prev.mentions_total : null;
  const whatChanged: string[] = latest.summary?.whatChanged ?? [];

  const goBrain = (node: string) => { setFocusNode(node); setRoom('brain'); };

  return (
    <div className="stack">
      <div className="brief-top">
        <div>
          <div className="eyebrow">Visibility</div>
          <div className="score-big num">{latest.mentions_total}<span className="score-of">/{latest.prompt_count}</span></div>
        </div>
        {delta !== null && (
          <div className={`delta ${delta >= 0 ? 'up' : 'down'}`}>{delta > 0 ? `↑ ${delta}` : delta < 0 ? `↓ ${Math.abs(delta)}` : '— even'}<div className="muted small">vs last week</div></div>
        )}
      </div>

      {/* Living mini-graph (Studio) */}
      <div className="brainmini" role="group" aria-label="Brain preview">
        <button className={`node lpt ${pointedNode === 'lpt' ? 'pulse-point' : ''}`} style={{ left: '26%', top: '30%', width: 78, height: 78 }} onClick={() => goBrain('lpt')}>Lucius P.<br />Thundercat</button>
        <button className={`node svr ${pointedNode === 'svr' ? 'pulse-point' : ''}`} style={{ left: '62%', top: '42%', width: 56, height: 56 }} onClick={() => goBrain('svr')}>Silk Velvet</button>
        <span className="muted small" style={{ position: 'absolute', left: '10%', top: '78%' }}>catalog · collaborators · platforms →</span>
      </div>

      {moment && (
        <div className="moment">
          <div className="said">“{moment.length > 200 ? moment.slice(0, 200) + '…' : moment}”</div>
          <button className="btn sm ghost" style={{ marginTop: '0.6rem' }} onClick={() => setRoom('workshop')}>Act on this →</button>
        </div>
      )}

      {whatChanged.length > 0 && (
        <section>
          <h2>What changed</h2>
          <ul className="journal">{whatChanged.slice(0, 5).map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}

      <div className="brief-counters">
        <div className="bc"><div className="n num">{counters.followers || '—'}</div><div className="muted small">followers</div></div>
        <div className="bc"><div className="n num">{counters.mentions}</div><div className="muted small">new mentions</div></div>
        <div className="bc"><div className="n num">{counters.ai}</div><div className="muted small">AI referrals</div></div>
      </div>
    </div>
  );
}
