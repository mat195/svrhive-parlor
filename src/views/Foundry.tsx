import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import { useSilk } from '../SilkContext';
import DraftCard, { type Draft } from '../components/DraftCard';

export default function Foundry() {
  const { draftsRev } = useSilk();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [query, setQuery] = useState('');
  const [gen, setGen] = useState(false);
  const [err, setErr] = useState('');
  const [sub, setSub] = useState<'active' | 'published' | 'history'>('active');

  const load = useCallback(async () => {
    const { data } = await supabase.from('corpus_drafts').select('*').order('created_at', { ascending: false });
    setDrafts((data as Draft[]) ?? []);
  }, []);
  useEffect(() => { load(); }, [load, draftsRev]);

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

  const active = drafts.filter((d) => ['proposed', 'edited'].includes(d.status));
  const published = drafts.filter((d) => d.status === 'published');
  const history = drafts.filter((d) => ['retracted', 'rejected'].includes(d.status));
  const shown = sub === 'published' ? published : sub === 'history' ? history : active;

  return (
    <div className="stack">
      <form className="composer" onSubmit={generate}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Draft a page targeting…" disabled={gen} />
        <button className="btn sm" type="submit" disabled={gen || !query.trim()}>{gen ? 'Drafting…' : 'Go'}</button>
      </form>
      {err && <p className="err small">{err}</p>}

      <div className="subtabs">
        <button className={sub === 'active' ? 'chip active' : 'chip'} onClick={() => setSub('active')}>Active ({active.length})</button>
        <button className={sub === 'published' ? 'chip active' : 'chip'} onClick={() => setSub('published')}>Published ({published.length})</button>
        <button className={sub === 'history' ? 'chip active' : 'chip'} onClick={() => setSub('history')}>History ({history.length})</button>
      </div>

      {shown.length === 0
        ? <p className="muted">{sub === 'published' ? 'No pages published yet. Publish a draft to see it here.' : sub === 'history' ? 'Nothing here yet.' : 'No drafts yet. Type a target query above, or wait for Silk to propose one.'}</p>
        : shown.map((d) => <DraftCard key={d.id} draft={d} onChange={load} />)}
    </div>
  );
}
