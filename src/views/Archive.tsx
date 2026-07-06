import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Tab = 'superseded' | 'retracted' | 'rejected' | 'resolved';

export default function Archive() {
  const [tab, setTab] = useState<Tab>('superseded');
  const [rows, setRows] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      if (tab === 'retracted') {
        const { data } = await supabase.from('corpus_drafts').select('id, target_query, retracted_at, live_url').eq('status', 'retracted').order('retracted_at', { ascending: false });
        setRows(data ?? []);
      } else if (tab === 'rejected') {
        const { data } = await supabase.from('action_queue').select('id, kind, payload, created_at').eq('status', 'rejected').order('created_at', { ascending: false });
        setRows(data ?? []);
      } else if (tab === 'resolved') {
        const { data } = await supabase.from('silk_questions').select('id, question, answer, answered_at').eq('status', 'answered').order('answered_at', { ascending: false });
        setRows(data ?? []);
      } else {
        setRows([{ id: 'producer', title: 'Identity: "hip-hop producer"', reason: 'Corrected — Lucius P. Thundercat is a rapper and vocalist, not a producer (Brief Three addendum).' }]);
      }
    })();
  }, [tab]);

  return (
    <div className="stack">
      <div className="eyebrow">Archive</div>
      <p className="muted small">Everything past, first-class. Nothing is hidden — it's remembered.</p>
      <div className="subtabs">
        {(['superseded', 'retracted', 'rejected', 'resolved'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'chip active' : 'chip'} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {rows.length === 0 ? <div className="silk-hint">Nothing archived here yet.</div> : (
        <ul className="rows">
          {rows.map((r) => (
            <li className="row" key={r.id}>
              {tab === 'superseded' && <><div style={{ textDecoration: 'line-through' }}>{r.title}</div><div className="muted small">{r.reason}</div></>}
              {tab === 'retracted' && <><div className="row-title">{r.target_query}</div><div className="muted small">retracted {String(r.retracted_at).slice(0, 16).replace('T', ' ')} · was {r.live_url}</div></>}
              {tab === 'rejected' && <><div className="row-title">{r.payload?.title ?? r.kind}</div><div className="muted small">{r.payload?.rationale?.slice(0, 120)}</div></>}
              {tab === 'resolved' && <><div>{r.question}</div><div className="muted small">→ {r.answer || '(answered)'} · {String(r.answered_at).slice(0, 10)}</div></>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
