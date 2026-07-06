import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Counted { name: string; count: number }
interface RunRow {
  id: string;
  run_at: string;
  prompt_count: number;
  mentions_total: number;
  label_mentions_total: number;
  summary: {
    artists?: Counted[];
    domains?: Counted[];
    byCategory?: Record<string, { total: number; mentioned: number }>;
    whatChanged?: string[];
  };
}

const CATS: Record<string, string> = {
  direct: 'Direct', category: 'Category', usecase: 'Use-case', local: 'Local', list: 'List',
};

export default function MorningBrief() {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [journal, setJournal] = useState<{ id: string; entry: string }[]>([]);
  const [metric, setMetric] = useState<{ platform: string; metric: string; value: number } | null>(null);

  useEffect(() => {
    (async () => {
      const { data: r } = await supabase
        .from('visibility_runs')
        .select('id, run_at, prompt_count, mentions_total, label_mentions_total, summary')
        .order('run_at', { ascending: false })
        .limit(2);
      setRuns((r as RunRow[]) ?? []);
      const { data: j } = await supabase
        .from('silk_journal').select('id, entry').order('created_at', { ascending: false }).limit(5);
      setJournal(j ?? []);
      const { data: m } = await supabase
        .from('metrics_snapshots').select('platform, metric, value').order('captured_at', { ascending: false }).limit(1);
      setMetric(m?.[0] ?? null);
    })();
  }, []);

  if (!runs) return <p className="muted">Loading…</p>;
  if (runs.length === 0) return <p className="muted">No battery runs yet.</p>;

  const [latest, prev] = runs;
  const delta = prev ? latest.mentions_total - prev.mentions_total : null;
  const cats = latest.summary?.byCategory ?? {};
  const artists = latest.summary?.artists ?? [];
  const domains = latest.summary?.domains ?? [];
  const maxCat = Math.max(1, ...Object.values(cats).map((c) => c.total));

  const whatChanged = latest.summary?.whatChanged ?? [];

  return (
    <div className="stack">
      {whatChanged.length > 0 && (
        <section className="card whatchanged">
          <h2 style={{ marginTop: 0 }}>What changed</h2>
          <ul className="journal">{whatChanged.map((c, i) => <li key={i}>{c}</li>)}</ul>
        </section>
      )}

      <section className="hero">
        <div className="score">{latest.mentions_total}<span className="of">/{latest.prompt_count}</span></div>
        <div className="scoremeta">
          <div>Lucius P. Thundercat visibility</div>
          <div className="muted">
            {latest.run_at.slice(0, 10)} ·{' '}
            {delta === null ? 'first run' : delta === 0 ? 'no change' : delta > 0 ? `▲ +${delta}` : `▼ ${delta}`} vs last
            {' '}· label {latest.label_mentions_total}/{latest.prompt_count}
          </div>
        </div>
      </section>

      <section>
        <h2>By category</h2>
        {Object.entries(CATS).map(([k, label]) => {
          const c = cats[k] ?? { total: 0, mentioned: 0 };
          return (
            <div className="bar-row" key={k}>
              <span className="bar-label">{label}</span>
              <span className="bar-track"><span className="bar-fill" style={{ width: `${(c.total / maxCat) * 100}%` }} /></span>
              <span className="bar-val">{c.mentioned}/{c.total}</span>
            </div>
          );
        })}
      </section>

      <div className="two-col">
        <section>
          <h2>Recommended instead</h2>
          {artists.length === 0 ? <p className="muted">—</p> : (
            <ol className="rank">{artists.slice(0, 6).map((a) => <li key={a.name}><span>{a.name}</span><span className="muted">{a.count}</span></li>)}</ol>
          )}
        </section>
        <section>
          <h2>Cited domains</h2>
          {domains.length === 0 ? <p className="muted">—</p> : (
            <ol className="rank">{domains.slice(0, 6).map((d) => <li key={d.name}><span>{d.name}</span><span className="muted">{d.count}</span></li>)}</ol>
          )}
        </section>
      </div>

      <section>
        <h2>Silk's journal</h2>
        <ul className="journal">{journal.map((j) => <li key={j.id}>{j.entry}</li>)}</ul>
      </section>

      <section>
        <h2>Latest metric</h2>
        {metric ? <p>{metric.platform} · {metric.metric}: <strong>{metric.value}</strong></p> : <p className="muted">No snapshot yet.</p>}
      </section>
    </div>
  );
}
