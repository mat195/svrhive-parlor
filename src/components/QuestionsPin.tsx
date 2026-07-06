import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import { useSilk } from '../SilkContext';

interface Q {
  id: string; question: string; why_asking: string | null; urgency: number;
  question_context: any; source_ref: any;
}

const draftKey = (id: string) => `qdraft:${id}`;

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
  const [pending, setPending] = useState(0);
  const { pointAt, askSilk } = useSilk();

  // Ref so realtime/effect handlers read the *current* answering state (no stale closure).
  const answeringRef = useRef(false);
  answeringRef.current = answering;

  // load(force): swaps the pinned question. While answering, it's LOCKED — updates
  // are queued (pending++) and applied only when the lock releases.
  const load = useCallback(async (force = false) => {
    if (answeringRef.current && !force) { setPending((p) => p + 1); return; }
    const { data } = await supabase.from('silk_questions')
      .select('id, question, why_asking, urgency, question_context, source_ref')
      .eq('status', 'open').order('urgency', { ascending: false }).order('created_at', { ascending: false }).limit(1);
    const next = data?.[0] ?? null;
    setQ(next);
    setAnswering(false);
    setShowSrc(false);
    setPending(0);
    setAnswer(next ? (localStorage.getItem(draftKey(next.id)) ?? '') : '');
    if (next?.source_ref?.node_key) pointAt(next.source_ref.node_key);
  }, [pointAt]);

  useEffect(() => {
    load();
    const ch = supabase.channel('questions-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'silk_questions' }, () => {
        if (answeringRef.current) setPending((p) => p + 1); else load(true);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  // Auto-save draft per question so nothing is lost if the sheet closes.
  useEffect(() => {
    if (q && answer) localStorage.setItem(draftKey(q.id), answer);
  }, [answer, q]);

  if (!q) return null;

  async function submit() {
    // Propagation cascade: writes mat_answers, files the review queue item, journals.
    // Falls back to a plain answer if the function is unreachable.
    try {
      await callFn('answer-propagate', { question_id: q!.id, answer });
    } catch {
      await supabase.from('silk_questions').update({ status: 'answered', answer, answered_at: new Date().toISOString() }).eq('id', q!.id);
    }
    localStorage.removeItem(draftKey(q!.id));
    load(true);
  }
  async function dismiss() {
    await supabase.from('silk_questions').update({ urgency: Math.max(0, q!.urgency - 2) }).eq('id', q!.id);
    load(true);
  }
  function cancelAnswer() {
    setAnswering(false); // draft is kept in localStorage
    if (pending > 0) load(true);
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
          <>
            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.5rem' }}>
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') cancelAnswer(); }}
                placeholder="Your answer…" style={{ flex: 1 }} autoFocus
              />
              <button className="btn sm" disabled={!answer.trim()} onClick={submit}>Save</button>
              <button className="btn sm ghost" onClick={cancelAnswer}>Cancel</button>
            </div>
            {pending > 0 && <div className="muted small" style={{ marginTop: '0.3rem' }}>answering — {pending} update{pending > 1 ? 's' : ''} pending</div>}
          </>
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
