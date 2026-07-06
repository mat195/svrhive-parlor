import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';

interface Q { id: string; question: string; context: string | null; urgency: number; source_ref: any }

export default function QuestionsPin() {
  const [q, setQ] = useState<Q | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');
  const { pointAt } = useSilk();

  const load = useCallback(async () => {
    const { data } = await supabase.from('silk_questions').select('id, question, context, urgency, source_ref')
      .eq('status', 'open').order('urgency', { ascending: false }).order('created_at', { ascending: false }).limit(1);
    const next = data?.[0] ?? null;
    setQ(next); setAnswering(false); setAnswer('');
    if (next?.source_ref?.node_key) pointAt(next.source_ref.node_key);
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!q) return null;

  async function submit() {
    await supabase.from('silk_questions').update({ status: 'answered', answer, answered_at: new Date().toISOString() }).eq('id', q!.id);
    load();
  }
  async function dismiss() {
    await supabase.from('silk_questions').update({ urgency: Math.max(0, q!.urgency - 2) }).eq('id', q!.id);
    // bump dismissed_count separately (can't do it inline without a fetch); approximate via urgency drop.
    load();
  }

  return (
    <div className="qpin">
      <span className="spider-dot" aria-hidden>◆</span>
      <div className="q">
        <div>{q.question}</div>
        {q.context && <div className="qctx">{q.context}</div>}
        {answering && (
          <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}>
            <input value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Your answer…" style={{ flex: 1 }} autoFocus />
            <button className="btn sm" disabled={!answer.trim()} onClick={submit}>Save</button>
          </div>
        )}
      </div>
      {!answering && (
        <div className="qacts">
          <button className="btn sm" onClick={() => setAnswering(true)}>Answer</button>
          <button className="btn sm ghost" onClick={dismiss} aria-label="Dismiss">Skip</button>
        </div>
      )}
    </div>
  );
}
