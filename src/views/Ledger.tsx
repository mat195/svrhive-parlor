import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Tab = 'results' | 'runs' | 'journal' | 'mentions' | 'metrics' | 'assemblies';
const TABS: { id: Tab; label: string }[] = [
  { id: 'results', label: 'Results' },
  { id: 'runs', label: 'Runs' },
  { id: 'journal', label: 'Journal' },
  { id: 'mentions', label: 'Mentions' },
  { id: 'metrics', label: 'Metrics' },
  { id: 'assemblies', label: 'Assemblies' },
];
const PAGE = 25;

export default function Ledger() {
  const [tab, setTab] = useState<Tab>('results');
  const [rows, setRows] = useState<any[]>([]);
  const [limit, setLimit] = useState(PAGE);
  const [category, setCategory] = useState('');
  const [engine, setEngine] = useState('');
  const [onlyMentioned, setOnlyMentioned] = useState(false);
  const [loading, setLoading] = useState(false);

  // Deep-link from command palette.
  useEffect(() => { const t = localStorage.getItem('ledger_tab'); if (t) { setTab(t as Tab); localStorage.removeItem('ledger_tab'); } }, []);

  useEffect(() => { setLimit(PAGE); }, [tab, category, engine, onlyMentioned]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      let q: any;
      if (tab === 'results') {
        q = supabase.from('visibility_results').select('id, created_at, category, engine, prompt, mentioned, response_excerpt, citations');
        if (category) q = q.eq('category', category);
        if (engine) q = q.eq('engine', engine);
        if (onlyMentioned) q = q.eq('mentioned', true);
        q = q.order('created_at', { ascending: false }).limit(limit);
      } else if (tab === 'runs') {
        q = supabase.from('visibility_runs').select('id, run_at, prompt_count, mentions_total, label_mentions_total, notes').order('run_at', { ascending: false }).limit(limit);
      } else if (tab === 'journal') {
        q = supabase.from('silk_journal').select('id, created_at, entry, tags').order('created_at', { ascending: false }).limit(limit);
      } else if (tab === 'mentions') {
        q = supabase.from('mentions_ledger').select('id, url, source, query, found_at').order('found_at', { ascending: false }).limit(limit);
      } else if (tab === 'metrics') {
        q = supabase.from('metrics_snapshots').select('id, platform, metric, value, captured_at').order('captured_at', { ascending: false }).limit(limit);
      } else {
        q = supabase.from('prompt_assemblies').select('id, created_at, surface, task_type, layer_1_hash, layer_3_skills, layer_4_entries, layer_5_functions').order('created_at', { ascending: false }).limit(limit);
      }
      const { data } = await q;
      setRows(data ?? []);
      setLoading(false);
    })();
  }, [tab, category, engine, onlyMentioned, limit]);

  return (
    <div className="stack">
      <div className="subtabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'chip active' : 'chip'} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {tab === 'results' && (
        <div className="filters">
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">all categories</option>
            {['direct', 'category', 'usecase', 'local', 'list'].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={engine} onChange={(e) => setEngine(e.target.value)}>
            <option value="">all engines</option>
            {['anthropic', 'openai', 'perplexity'].map((e) => <option key={e} value={e}>{e}</option>)}
          </select>
          <label className="check"><input type="checkbox" checked={onlyMentioned} onChange={(e) => setOnlyMentioned(e.target.checked)} /> mentioned only</label>
        </div>
      )}

      {loading && rows.length === 0 ? <p className="muted">Loading…</p> : (
        <ul className="rows">
          {rows.map((r) => <li key={r.id} className="row">{renderRow(tab, r)}</li>)}
          {rows.length === 0 && <p className="muted">No rows.</p>}
        </ul>
      )}

      {rows.length >= limit && (
        <button className="btn ghost" onClick={() => setLimit((l) => l + PAGE)}>Load more</button>
      )}
    </div>
  );
}

function renderRow(tab: Tab, r: any) {
  if (tab === 'results') {
    return (
      <>
        <div className="row-head">
          <span className={r.mentioned ? 'pill hit' : 'pill'}>{r.mentioned ? 'LPT mentioned' : 'LPT: not mentioned'}</span>
          <span className="muted">{r.engine} · {r.category}</span>
        </div>
        <div className="row-title">{r.prompt}</div>
        {r.response_excerpt && <div className="row-ex muted">{r.response_excerpt.slice(0, 220)}</div>}
        {Array.isArray(r.citations) && r.citations.length > 0 && <div className="muted small">{r.citations.length} citations</div>}
      </>
    );
  }
  if (tab === 'runs') return <><div className="row-title">{r.mentions_total}/{r.prompt_count} · {String(r.run_at).slice(0, 16).replace('T', ' ')}</div><div className="muted small">label {r.label_mentions_total} · {r.notes}</div></>;
  if (tab === 'journal') return <><div>{r.entry}</div><div className="muted small">{(r.tags ?? []).join(' · ')} · {String(r.created_at).slice(0, 10)}</div></>;
  if (tab === 'mentions') return <><a href={r.url} target="_blank" rel="noopener">{r.url}</a><div className="muted small">{r.source} · {r.query}</div></>;
  if (tab === 'assemblies') return (
    <>
      <div className="row-head"><span className="pill">{r.surface}</span><span className="muted small">{r.task_type} · {String(r.created_at).slice(0, 16).replace('T', ' ')}</span></div>
      <div className="muted small">L1 <code>{r.layer_1_hash}</code> · L3 skills: {(r.layer_3_skills ?? []).join(', ') || 'none'} · L4 memory: {(r.layer_4_entries ?? []).length} · L5 fns: {(r.layer_5_functions ?? []).length}</div>
    </>
  );
  return <><div className="row-title">{r.platform} · {r.metric}: {r.value}</div><div className="muted small">{String(r.captured_at).slice(0, 16).replace('T', ' ')}</div></>;
}
