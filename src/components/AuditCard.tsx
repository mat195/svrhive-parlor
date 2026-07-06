import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';

interface Item { name: string; release: string; year?: string }
interface Cluster { label: string; tier: string; items: Item[] }
interface AuditPayload {
  title: string; header: string; summary: string[]; clusters: Cluster[];
  actions: { primary: string; secondary: string; tertiary: string };
  draft_id?: string;
}

function ClusterBlock({ c }: { c: Cluster }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? c.items : c.items.slice(0, 8);
  return (
    <div className="audit-cluster">
      <div className={`audit-cluster-label ${c.tier === 'strategic' ? 'strategic' : ''}`}>{c.label}</div>
      <ul className="audit-items">
        {shown.map((it, i) => (
          <li key={i}><strong>{it.name}</strong> <span className="muted small">— {it.release}{it.year ? ` (${it.year})` : ''}</span></li>
        ))}
      </ul>
      {c.items.length > 8 && (
        <button className="link audit-more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'show less' : `show all ${c.items.length}`}
        </button>
      )}
    </div>
  );
}

export default function AuditCard({ item, onChange }: { item: any; onChange: () => void }) {
  const p = item.payload as AuditPayload;
  const [raw, setRaw] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const { askSilk } = useSilk();

  async function decide(status: string, note?: string) {
    setBusy(status);
    await supabase.from('action_queue').update({ status, payload: { ...item.payload, decided_at: new Date().toISOString(), ...(note ? { mat_note: note } : {}) } }).eq('id', item.id);
    setBusy(''); onChange();
  }
  async function viewRaw() {
    if (raw !== null) { setRaw(null); return; }
    if (!p.draft_id) return;
    const { data } = await supabase.from('drafts').select('content').eq('id', p.draft_id).single();
    setRaw(data?.content ?? '(no raw data)');
  }

  return (
    <div className="card auditcard">
      <div className="audit-header">{p.header}</div>
      <ul className="audit-summary">{p.summary?.map((s, i) => <li key={i}>{s}</li>)}</ul>

      {p.clusters?.map((c, i) => <ClusterBlock key={i} c={c} />)}

      <div className="audit-actions">
        <button className="btn sm" disabled={!!busy} onClick={() => decide('approved')}>{p.actions?.primary ?? 'Approve'}</button>
        <button className="btn sm ghost" disabled={!!busy} onClick={() => { const n = window.prompt('Edits / note:') ?? ''; decide('approved', n); }}>{p.actions?.secondary ?? 'Approve with edits'}</button>
        <button className="btn sm ghost" disabled={!!busy} onClick={() => decide('rejected')}>{p.actions?.tertiary ?? 'Reject'}</button>
      </div>
      <div className="audit-foot">
        <button className="link small" onClick={viewRaw}>{raw !== null ? 'hide raw' : 'view raw'}</button>
        <button className="link small" onClick={() => askSilk(`About the catalog audit (${p.title}): `)}>Ask Silk</button>
      </div>
      {raw !== null && <pre className="audit-raw">{raw.slice(0, 4000)}</pre>}
    </div>
  );
}
