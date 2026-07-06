import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import DraftCard, { type Draft } from '../components/DraftCard';

export default function Foundry() {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [query, setQuery] = useState('');
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState('');
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from('corpus_drafts').select('*').order('created_at', { ascending: false });
    setDrafts((data as Draft[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load]);

  async function generate(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q || gen) return;
    setGen(true); setErr('');
    try { await callFn('foundry-generate', { target_query: q }); setQuery(''); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setGen(false);
  }

  if (!drafts) return <p className="muted">Loading…</p>;

  const active = drafts.filter((d) => ['proposed', 'edited', 'published'].includes(d.status));
  const history = drafts.filter((d) => ['retracted', 'rejected'].includes(d.status));
  const shown = showHistory ? history : active;

  return (
    <div className="stack">
      <form className="composer" onSubmit={generate}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Draft a page targeting…" disabled={gen} />
        <button className="btn sm" type="submit" disabled={gen || !query.trim()}>{gen ? 'Drafting…' : 'Go'}</button>
      </form>
      {err && <p className="err small">{err}</p>}

      <div className="subtabs">
        <button className={!showHistory ? 'chip active' : 'chip'} onClick={() => setShowHistory(false)}>Active ({active.length})</button>
        <button className={showHistory ? 'chip active' : 'chip'} onClick={() => setShowHistory(true)}>History ({history.length})</button>
      </div>

      {shown.length === 0
        ? <p className="muted">{showHistory ? 'Nothing here yet.' : 'No drafts yet. Type a target query above, or wait for Silk to propose one.'}</p>
        : shown.map((d) => <DraftCard key={d.id} draft={d} onChange={load} />)}
    </div>
  );
}
