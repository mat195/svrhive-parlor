import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import AuditCard from '../components/AuditCard';
import { useToast } from '../components/Toast';

interface QueueItem {
  id: string;
  kind: string;
  status: string;
  created_at: string;
  payload: { rationale?: string; draft_id?: string; decided_at?: string; mat_note?: string; generated_by?: string; [k: string]: unknown };
}

const STATUS_CLASS: Record<string, string> = {
  proposed: 'chip', approved: 'chip ok', rejected: 'chip err', done: 'chip done',
};

const isInitiative = (it: QueueItem) => it.payload?.generated_by === 'workshop_initiative';

export default function Queue() {
  const toast = useToast();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { kind: string; content: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'initiatives' | 'mat'>('all');

  useEffect(() => {
    if (localStorage.getItem('workshop_filter') === 'initiatives') { setFilter('initiatives'); localStorage.removeItem('workshop_filter'); }
  }, []);

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
    const prev = item.payload;
    const payload = { ...item.payload, decided_at: new Date().toISOString(), mat_note: note };
    const { error } = await supabase.from('action_queue').update({ status, payload }).eq('id', item.id);
    setBusy(null);
    if (error) { alert(error.message); return; }
    if (status === 'rejected') {
      toast('Item rejected', async () => { await supabase.from('action_queue').update({ status: 'proposed', payload: prev }).eq('id', item.id); load(); });
    }
    load();
  }

  if (!items) return <p className="muted">Loading…</p>;

  const initiativeCount = items.filter((it) => isInitiative(it) && it.status === 'proposed').length;
  const shown = items.filter((it) => filter === 'all' ? true : filter === 'initiatives' ? isInitiative(it) : !isInitiative(it));

  return (
    <div className="stack">
      <div className="subtabs">
        <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>All ({items.length})</button>
        <button className={filter === 'initiatives' ? 'chip active' : 'chip'} onClick={() => setFilter('initiatives')}>◆ Silk's Initiatives ({initiativeCount})</button>
        <button className={filter === 'mat' ? 'chip active' : 'chip'} onClick={() => setFilter('mat')}>Mat-triggered</button>
      </div>

      {shown.length === 0
        ? <p className="muted">{filter === 'initiatives' ? "No initiatives from Silk right now — he proposes overnight when there's high-leverage work." : 'Queue empty. Silk proposes actions here; nothing executes without your approval.'}</p>
        : shown.map((it) => (
        (it.payload as any)?.format === 'audit' && it.status === 'proposed'
          ? <AuditCard key={it.id} item={it} onChange={load} />
          : <div className="card queue" key={it.id}>
          <div className="row-head">
            <span className={STATUS_CLASS[it.status] ?? 'chip'}>{it.status}</span>
            <span className="muted small">{isInitiative(it) && <span className="init-tag">◆ initiative</span>} {it.kind} · {String(it.created_at).slice(0, 10)}</span>
          </div>
          {(it.payload.title as string) && <div className="draft-query">{it.payload.title as string}</div>}
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
