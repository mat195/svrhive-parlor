import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import AuditCard from '../components/AuditCard';
import { useToast } from '../components/Toast';

type Risk = 'green' | 'amber' | 'red' | 'grey';
interface QueueItem {
  id: string; kind: string; status: string; created_at: string; risk_tier: Risk | null;
  payload: { rationale?: string; title?: string; draft_id?: string; decided_at?: string; mat_note?: string; generated_by?: string; target_query?: string; [k: string]: unknown };
}

const STATUS_CLASS: Record<string, string> = { proposed: 'chip', approved: 'chip ok', rejected: 'chip err', done: 'chip done' };
const RISK_META: Record<Risk, { label: string }> = {
  green: { label: 'no external impact' },
  amber: { label: 'changes canonical facts' },
  red: { label: 'publishes to silkvelvetrecords.com' },
  grey: { label: 'your decision, no action' },
};
const RISK_ORDER: Record<Risk, number> = { grey: 0, green: 1, amber: 2, red: 3 };
const tierOf = (it: QueueItem): Risk => it.risk_tier ?? 'amber';
const isInitiative = (it: QueueItem) => it.payload?.generated_by === 'workshop_initiative';
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Plain "what happens if I approve" + effort estimate, per card type.
function approvalInfo(it: QueueItem): { what: string; effort: string } {
  const q = String(it.payload?.target_query ?? it.payload?.focus ?? '[query]');
  const slug = slugify(q);
  const k = it.kind;
  if (k === 'corpus-initiative' || k === 'corpus-page')
    return { what: `Silk drafts the full page targeting "${q}". The draft appears in Workshop → Drafts for your review. Nothing publishes yet — you review the draft, then decide whether to publish it live to silkvelvetrecords.com/notes/${slug}/.`, effort: '~5 min to draft' };
  if (k === 'audit-initiative' || k === 'catalog-audit' || k === 'catalog-audit-supplemental')
    return { what: `Silk runs the audit using his tools. Results log to the ledger (visibility_runs / catalog tables). Findings surface as a summary in your morning brief. No changes to the entity master or any public surface.`, effort: '~30s–2 min' };
  if (k === 'entity-submission')
    return { what: `Generates/updates a paste-ready kit (MusicBrainz / Wikidata / etc.) in Workshop → Listings. Nothing submits externally until you use the guided paste wizard.`, effort: '~2 min' };
  if (k === 'doctrine-sync' || k === 'weekly-consolidation')
    return { what: `Updates SILK_IDENTITY.md doctrine (runtime + repo). Changes how Silk behaves going forward. Reversible; old version archived in doctrine_versions.`, effort: '~1 min' };
  if (k === 'bio-approval' || k === 'bio-revision')
    return { what: `Updates the bio (queued, not published). It flows to the entity master; the public site only changes if you later publish it.`, effort: '~1 min' };
  if (k === 'tier-reclass')
    return { what: `Applies the reclassification to the affected §6 releases, adds tier_history entries, and updates any release pages currently rendering them differently. Nothing external changes — internal categorization only.`, effort: '~2 min' };
  if (k === 'answer-cascade' || k === 'appears-on-audit' || k === 'catalog-backfill' || k === 'metadata-fix' || k === 'revise-role' || k === 'reference-swap' || k === 'genre-change')
    return { what: `Updates the entity master with the proposed change. The cascade fires to the affected surfaces (Brain, bios, submission kits as applicable). Provenance is logged and the old value archived.`, effort: '~1–2 min' };
  if (tierOf(it) === 'grey')
    return { what: `Your answer routes through mat_answers → the cascade updates the affected fields. Nothing executes on a public surface without your further action.`, effort: 'your call' };
  return { what: `Records your decision. Nothing executes on a public surface without your further action.`, effort: '~1 min' };
}

export default function Queue() {
  const toast = useToast();
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { kind: string; content: string }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'initiatives' | 'mat'>('all');
  const [risk, setRisk] = useState<'all' | Risk>('all');

  useEffect(() => {
    if (localStorage.getItem('workshop_filter') === 'initiatives') { setFilter('initiatives'); localStorage.removeItem('workshop_filter'); }
  }, []);

  async function load() {
    const { data } = await supabase.from('action_queue').select('id, kind, status, created_at, risk_tier, payload').order('created_at', { ascending: false });
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
    const { error } = await supabase.from('action_queue').update({ status, payload: { ...item.payload, decided_at: new Date().toISOString(), mat_note: note } }).eq('id', item.id);
    setBusy(null);
    if (error) { alert(error.message); return; }
    if (status === 'rejected') toast('Item rejected', async () => { await supabase.from('action_queue').update({ status: 'proposed', payload: prev }).eq('id', item.id); load(); });
    load();
  }

  // Batch-approve every visible GREEN item (zero-risk). 10s undo (bigger surface area).
  async function approveAllGreen(greenItems: QueueItem[]) {
    if (!greenItems.length) return;
    const ids = greenItems.map((g) => g.id);
    for (const g of greenItems) await supabase.from('action_queue').update({ status: 'approved', payload: { ...g.payload, decided_at: new Date().toISOString(), batch: 'green' } }).eq('id', g.id);
    load();
    toast(`Approved ${ids.length} green item${ids.length > 1 ? 's' : ''}`, async () => {
      for (const g of greenItems) await supabase.from('action_queue').update({ status: 'proposed', payload: g.payload }).eq('id', g.id);
      load();
    }, 10000);
  }

  if (!items) return <p className="muted">Loading…</p>;

  const initiativeCount = items.filter((it) => isInitiative(it) && it.status === 'proposed').length;
  let shown = items.filter((it) => filter === 'all' ? true : filter === 'initiatives' ? isInitiative(it) : !isInitiative(it));
  if (risk !== 'all') shown = shown.filter((it) => tierOf(it) === risk);
  // Sort proposed items by risk tier (grey → green → amber → red); decided items after.
  shown = [...shown].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'proposed' ? -1 : 1;
    return RISK_ORDER[tierOf(a)] - RISK_ORDER[tierOf(b)];
  });
  const riskCount = (t: Risk) => items.filter((it) => it.status === 'proposed' && tierOf(it) === t).length;
  const visibleGreen = shown.filter((it) => it.status === 'proposed' && tierOf(it) === 'green');

  return (
    <div className="stack">
      <div className="subtabs">
        <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>All ({items.length})</button>
        <button className={filter === 'initiatives' ? 'chip active' : 'chip'} onClick={() => setFilter('initiatives')}>◆ Silk's Initiatives ({initiativeCount})</button>
        <button className={filter === 'mat' ? 'chip active' : 'chip'} onClick={() => setFilter('mat')}>Mat-triggered</button>
      </div>
      <div className="subtabs">
        <span className="muted small" style={{ alignSelf: 'center' }}>risk:</span>
        <button className={risk === 'all' ? 'chip active' : 'chip'} onClick={() => setRisk('all')}>all</button>
        {(['grey', 'green', 'amber', 'red'] as Risk[]).map((t) => (
          <button key={t} className={risk === t ? 'chip active' : 'chip'} onClick={() => setRisk(t)}><span className={`risk-dot risk-${t}`} /> {t} ({riskCount(t)})</button>
        ))}
      </div>

      {visibleGreen.length > 0 && (
        <button className="btn sm" onClick={() => approveAllGreen(visibleGreen)}>
          <span className="risk-dot risk-green" /> Approve all green ({visibleGreen.length})
        </button>
      )}

      {shown.length === 0
        ? <p className="muted">{filter === 'initiatives' ? "No initiatives from Silk right now." : 'Nothing here.'}</p>
        : shown.map((it) => {
          const t = tierOf(it);
          const slug = it.payload?.target_query ? String(it.payload.target_query).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') : null;
          return (it.payload as any)?.format === 'audit' && it.status === 'proposed'
            ? <AuditCard key={it.id} item={it} onChange={load} />
            : <div className={`card queue risk-card-${t}`} key={it.id}>
            <div className="row-head">
              <span className={`risk-dot risk-${t}`} title={RISK_META[t].label} />
              <span className={STATUS_CLASS[it.status] ?? 'chip'}>{it.status}</span>
              <span className="muted small">{isInitiative(it) && <span className="init-tag">◆ initiative</span>} {it.kind} · {String(it.created_at).slice(0, 10)}</span>
            </div>
            {(it.payload.title as string) && <div className="draft-query">{it.payload.title as string}</div>}
            <div className={`risk-label risk-${t}`}>{RISK_META[t].label}</div>
            {t === 'red' && <div className="risk-impact">if approved: commits and deploys to silkvelvetrecords.com/notes/{slug ?? '[slug]'}/, retractable for 15 min</div>}
            {(() => { const info = approvalInfo(it); return (
              <>
                <div className="what-happens"><strong>If approved:</strong> {info.what}</div>
                <span className="effort-chip">⏱ {info.effort}</span>
              </>
            ); })()}
            {it.payload.rationale && <details className="rationale-x"><summary>See Silk's full rationale</summary><p className="rationale">{it.payload.rationale}</p></details>}
            {it.payload.draft_id && drafts[it.payload.draft_id] && (
              <details className="draft"><summary>Attached draft ({drafts[it.payload.draft_id].kind})</summary><pre>{drafts[it.payload.draft_id].content}</pre></details>
            )}
            {it.status === 'proposed' ? (
              <div className="actions">
                <button className="btn sm" disabled={busy === it.id} onClick={() => decide(it, 'approved')}>Approve</button>
                <button className="btn sm ghost" disabled={busy === it.id} onClick={() => decide(it, 'rejected')}>Reject</button>
              </div>
            ) : (
              <div className="muted small">{it.payload.decided_at ? `${it.status} ${String(it.payload.decided_at).slice(0, 16).replace('T', ' ')}` : it.status}{it.payload.mat_note ? ` — "${it.payload.mat_note}"` : ''}</div>
            )}
          </div>;
        })}
    </div>
  );
}
