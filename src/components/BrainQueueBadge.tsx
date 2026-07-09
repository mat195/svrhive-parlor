import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';

// The lightweight replacement for the old inline review cards in the chat bubble: a single count
// line — "N questions + M notes pending in Brain →" — that jumps straight to the pinned queue in
// the Brain room. No inline card list anymore; the full review lives in Brain.
export default function BrainQueueBadge() {
  const [q, setQ] = useState(0);
  const [n, setN] = useState(0);
  const { setRoom, setFocusNode } = useSilk();

  const load = useCallback(async () => {
    const [qr, nr] = await Promise.all([
      supabase.from('silk_questions').select('id', { count: 'exact', head: true }).in('status', ['pending', 'open']),
      supabase.from('chat_extractions').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);
    setQ(qr.count ?? 0); setN(nr.count ?? 0);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel('brain-queue-badge')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'silk_questions' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_extractions' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const total = q + n;
  if (total === 0) return null;

  const go = () => {
    setFocusNode(null);
    setRoom('brain');
    setTimeout(() => document.getElementById('brain-queue')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };
  const parts: string[] = [];
  if (q) parts.push(`${q} question${q > 1 ? 's' : ''}`);
  if (n) parts.push(`${n} note${n > 1 ? 's' : ''}`);

  return (
    <button className="brainq-badge" onClick={go} title="Review Silk's questions and notes in Brain">
      <span className="brainq-badge-dot c-unverified" />
      <span>{parts.join(' + ')} pending in <strong>Brain</strong></span>
      <span className="brainq-badge-arrow" aria-hidden="true">→</span>
    </button>
  );
}
