import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface QueueItem {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  payload: { rationale?: string; draft_id?: string; decided_at?: string; mat_note?: string; [k: string]: unknown };
}

const STATUS_CLASS: Record<string, string> = {
  proposed: 'chip', approved: 'chip ok', rejected: 'chip err', done: 'chip done',
};

export default function Queue() {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { kind: string; content: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    const { data } = await supabase
      .from('action_queue')
      .select('id, kind, status, created_at, payload')
      .order('created_at', { ascending: false });
    setItems((data as QueueItem[]) ?? []);
    const draftIds = (data ?? []).map((d: any) => d.payload?.draft_id).filter(Boolean);
    if (draftIds.length) {
      const { data: dr } = await supabase.from('drafts').select('id, kind, content').in('id', draftIds);
      const map: Record<string, { kind: string; content: string }> = {};
      (dr ?? []).forEach((d: any) => (map[d.id] = { kind: d.kind, content: d.content }));
      setDrafts(map);
    }
  }
  useEffect(() => { load(); }, []);

  async function decide(item: QueueItem, status: 'approved' | 'rejected') {
    setBusy(item.id);
    const note = window.prompt(`Optional note for ${status}:`) ?? '';
    // Records the decision only. Does NOT auto-execute anything (Corpus Foundry wires execution).
    const payload = { ...item.payload, decided_at: new Date().toISOString(), mat_note: note };
    const { error } = await supabase.from('action_queue').update({ status, payload }).eq('id', item.id);
    setBusy(null);
    if (error) alert(error.message);
    else load();
  }

  if (!items) return <p className="muted">Loading…</p>;
  if (items.length === 0) return <p className="muted">Queue empty. Silk proposes actions here; nothing executes without your approval.</p>;

  return (
    <div className="stack">
      {items.map((it) => (
        <div className="card queue" key={it.id}>
          <div className="row-head">
            <span className={STATUS_CLASS[it.status] ?? 'chip'}>{it.status}</span>
            <span className="muted small">{it.kind} · {String(it.created_at).slice(0, 10)}</span>
          </div>
          {it.payload.rationale && <p className="rationale">{it.payload.rationale}</p>}
          {it.payload.draft_id && drafts[it.payload.draft_id] && (
            <details className="draft"><summary>Attached draft ({drafts[it.payload.draft_id].kind})</summary>
              <pre>{drafts[it.payload.draft_id].content}</pre>
            </details>
          )}
          {it.status === 'proposed' ? (
            <div className="actions">
              <button className="btn sm" disabled={busy === it.id} onClick={() => decide(it, 'approved')}>Approve</button>
              <button className="btn sm ghost" disabled={busy === it.id} onClick={() => decide(it, 'rejected')}>Reject</button>
            </div>
          ) : (
            <div className="muted small">
              {it.payload.decided_at ? `${it.status} ${String(it.payload.decided_at).slice(0, 16).replace('T', ' ')}` : it.status}
              {it.payload.mat_note ? ` — "${it.payload.mat_note}"` : ''}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
