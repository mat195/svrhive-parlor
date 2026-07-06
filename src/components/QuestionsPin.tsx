import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';

interface Q {
  id: string; question: string; why_asking: string | null; urgency: number;
  question_context: any; source_ref: any;
}

function ContextPreview({ ctx }: { ctx: any }) {
  if (!ctx || !ctx.type) return null;
  if (ctx.type === 'link' || ctx.type === 'platform') {
    return (
      <div className="qctx-card">
        <span className="muted small">{ctx.platform || 'link'}</span>
        <a href={ctx.url} target="_blank" rel="noopener" className="qctx-url">{ctx.url} <span className="muted">open ↗</span></a>
      </div>
    );
  }
  if (ctx.type === 'release') {
    return (
      <div className="qctx-card">
        {ctx.coverArt ? <img src={ctx.coverArt} alt="" width="40" height="40" style={{ borderRadius: 6 }} /> : <div className="qctx-thumb">♪</div>}
        <div><div>{ctx.title}</div><div className="muted small">{ctx.date || 'date TBD'}</div></div>
      </div>
    );
  }
  if (ctx.type === 'collaborator') {
    return <div className="qctx-card"><div className="qctx-thumb">◑</div><div><div>{ctx.name}</div><div className="muted small">{ctx.role}{ctx.release ? ` · on "${ctx.release}"` : ''}</div></div></div>;
  }
  if (ctx.type === 'text') {
    return <div className="qctx-card"><blockquote className="qctx-quote">{ctx.label}: {ctx.value}</blockquote></div>;
  }
  return null;
}

export default function QuestionsPin() {
  const [q, setQ] = useState<Q | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');
  const [showSrc, setShowSrc] = useState(false);
  const { pointAt, askSilk } = useSilk();

  const load = useCallback(async () => {
    const { data } = await supabase.from('silk_questions')
      .select('id, question, why_asking, urgency, question_context, source_ref')
      .eq('status', 'open').order('urgency', { ascending: false }).order('created_at', { ascending: false }).limit(1);
    const next = data?.[0] ?? null;
    setQ(next); setAnswering(false); setAnswer(''); setShowSrc(false);
    if (next?.source_ref?.node_key) pointAt(next.source_ref.node_key);
  }, [pointAt]);
  useEffect(() => { load(); }, [load]);

  if (!q) return null;

  async function submit() {
    await supabase.from('silk_questions').update({ status: 'answered', answer, answered_at: new Date().toISOString() }).eq('id', q!.id);
    load();
  }
  async function dismiss() {
    await supabase.from('silk_questions').update({ urgency: Math.max(0, q!.urgency - 2) }).eq('id', q!.id);
    load();
  }

  return (
    <div className="qpin">
      <div className="q">
        <div className="qhead">
          <span className="q-text">{q.question}</span>
          {q.source_ref && Object.keys(q.source_ref).length > 0 && (
            <button className="q-info" title="Where this comes from" onClick={() => setShowSrc((s) => !s)}>ⓘ</button>
          )}
        </div>
        {q.why_asking && <div className="qwhy">{q.why_asking}</div>}
        <ContextPreview ctx={q.question_context} />
        {showSrc && <div className="muted small qsrc">source: {JSON.stringify(q.source_ref)}</div>}
        {answering && (
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer…" style={{ flex: 1 }} autoFocus />
            <button className="btn sm" disabled={!answer.trim()} onClick={submit}>Save</button>
          </div>
        )}
      </div>
      {!answering && (
        <div className="qacts">
          <button className="btn sm" onClick={() => setAnswering(true)}>Answer</button>
          <button className="btn sm ghost" onClick={() => askSilk(`About "${q.question}": `)}>Ask Silk</button>
          <button className="btn sm ghost" onClick={dismiss} aria-label="Skip">Skip</button>
        </div>
      )}
    </div>
  );
}
