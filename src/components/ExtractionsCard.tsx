import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';

// ExtractionsCard (Brief Six) — the ambient retention surface. When the distiller
// proposes memory from a conversation, it appears here as ONE collapsed card in
// Silk's column: "N new facts from our conversation — review." Mat approves the
// batch at his own pace; superseding facts show before/after; nothing touched canon
// until he acts. Approve routes through extraction-approve → the real cascade.

interface Extraction {
  id: string; extraction_type: string; confidence: string;
  proposed_content: { summary?: string; canonical?: string; target_field?: string | null };
  target_field: string | null;
  provenance: { quote?: string } | null;
  supersedes: { field: string; old_value: string; new_value: string } | null;
}

const TYPE_LABEL: Record<string, string> = {
  fact: 'fact', preference: 'preference', correction: 'correction', instinct: 'instinct', question: 'question',
};

export default function ExtractionsCard() {
  const [rows, setRows] = useState<Extraction[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const { data } = await supabase.from('chat_extractions')
      .select('id, extraction_type, confidence, proposed_content, target_field, provenance, supersedes')
      .eq('status', 'pending').order('created_at', { ascending: false });
    const list = (data ?? []) as Extraction[];
    setRows(list);
    setSel((s) => { const n = { ...s }; for (const r of list) if (!(r.id in n)) n[r.id] = true; return n; });
  }, []);

  useEffect(() => {
    load();
    const ch = supabase.channel('extractions-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'chat_extractions' }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  if (rows.length === 0) return null;
  const selectedIds = rows.filter((r) => sel[r.id]).map((r) => r.id);

  async function decide(action: 'approve' | 'reject', ids: string[]) {
    if (busy || ids.length === 0) return;
    setBusy(true);
    try {
      const editMap: Record<string, { canonical: string }> = {};
      if (action === 'approve') for (const id of ids) if (edits[id] != null) editMap[id] = { canonical: edits[id] };
      await callFn('extraction-approve', { action, extraction_ids: ids, edits: editMap });
    } finally { setBusy(false); await load(); }
  }

  return (
    <div className="qstrip xstrip">
      <button className="qstrip-bar" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
        <span className="xstrip-dot" />
        <span className="qstrip-label">{rows.length} new {rows.length > 1 ? 'notes' : 'note'} from our conversation <span className="muted">· review</span></span>
        <span className="qstrip-chev">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="qstrip-card">
          <ul className="xstrip-list">
            {rows.map((r) => {
              const canon = edits[r.id] ?? r.proposed_content?.canonical ?? r.proposed_content?.summary ?? '';
              return (
                <li key={r.id} className={sel[r.id] ? '' : 'deselected'}>
                  <label className="xstrip-head">
                    <input type="checkbox" checked={!!sel[r.id]} onChange={(e) => setSel((s) => ({ ...s, [r.id]: e.target.checked }))} />
                    <span className={`xstrip-badge x-${r.extraction_type}`}>{TYPE_LABEL[r.extraction_type] ?? r.extraction_type}</span>
                    <span className="muted small">{r.target_field || ''} · {r.confidence}</span>
                  </label>
                  <div className="xstrip-summary">{r.proposed_content?.summary}</div>
                  {r.supersedes && (
                    <div className="xstrip-supersede">
                      <span className="x-old">{r.supersedes.old_value}</span> → <span className="x-new">{r.supersedes.new_value}</span>
                    </div>
                  )}
                  <input className="xstrip-canon" value={canon} onChange={(e) => setEdits((m) => ({ ...m, [r.id]: e.target.value }))} aria-label="Canonical form (editable)" />
                  {r.provenance?.quote && <div className="xstrip-quote">“{r.provenance.quote}”</div>}
                </li>
              );
            })}
          </ul>
          <div className="xstrip-acts">
            <button className="btn sm" disabled={busy || selectedIds.length === 0} onClick={() => decide('approve', selectedIds)}>
              Approve {selectedIds.length}{edits && Object.keys(edits).length ? ' (with edits)' : ''}
            </button>
            <button className="btn sm ghost" disabled={busy || selectedIds.length === 0} onClick={() => decide('reject', selectedIds)}>Reject {selectedIds.length}</button>
            <button className="link small" disabled={busy} onClick={() => decide('approve', rows.map((r) => r.id))}>Approve all {rows.length}</button>
          </div>
        </div>
      )}
    </div>
  );
}
