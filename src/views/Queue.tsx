import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import AuditCard from '../components/AuditCard';
import { useToast } from '../components/Toast';

// Kinds whose approval must synchronously create a corpus_drafts row (verified).
const DRAFT_KINDS = new Set(['corpus-initiative', 'corpus-page']);

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
    return { what: `Updates Silk's rules (runtime + rulebook). Changes how Silk behaves going forward. Reversible; the old version is archived in the rule history.`, effort: '~1 min' };
  if (k === 'bio-approval' || k === 'bio-revision')
    return { what: `Records this bio as the canonical version in Silk's fact ledger (entity_facts). It does NOT publish to the public site — silkvelvetrecords.com is updated in a separate step. The item stays open until the live site is verified to show the new text.`, effort: 'record now; site later' };
  if (k === 'tier-reclass')
    return { what: `Records the reclassification in the fact ledger (entity_facts) with a tier_history entry. Internal categorization only — no public surface changes automatically.`, effort: '~1 min' };
  if (k === 'answer-cascade' || k === 'appears-on-audit' || k === 'catalog-backfill' || k === 'metadata-fix' || k === 'revise-role' || k === 'reference-swap' || k === 'genre-change')
    return { what: `Records this as a canonical fact in Silk's ledger (entity_facts), with provenance logged and the old value superseded. This does NOT automatically change the public site, bios, or submission kits — those are separate publish steps. If the fact names a public surface, the item stays open until that live surface is verified to show the new value.`, effort: 'record now; publish separately' };
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
  const [showHistory, setShowHistory] = useState(false);

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
    // Draft-creation approvals MUST synchronously create the draft and verify it
    // landed before showing "approved" (approved ≠ done unless verified).
    if (status === 'approved' && DRAFT_KINDS.has(item.kind)) return approveDraftCreation(item);
    setBusy(item.id);
    const note = window.prompt(`Optional note for ${status}:`) ?? '';
    const prev = item.payload;
    const { error } = await supabase.from('action_queue').update({ status, payload: { ...item.payload, decided_at: new Date().toISOString(), mat_note: note } }).eq('id', item.id);
    setBusy(null);
    if (error) { alert(error.message); return; }
    if (status === 'rejected') toast('Item rejected', async () => { await supabase.from('action_queue').update({ status: 'proposed', payload: prev }).eq('id', item.id); load(); });
    load();
  }

  // Approve a draft-creation item: trigger foundry-generate, verify the corpus_drafts
  // row was created, link it, THEN mark approved. On failure the item stays in the
  // queue with an error (never a silent "approved" with no draft).
  async function approveDraftCreation(item: QueueItem) {
    const q = String(item.payload?.target_query ?? '').trim();
    setBusy(item.id);
    try {
      if (!q) throw new Error('no target_query on this item');
      const r = await callFn('foundry-generate', { target_query: q });
      if (!r?.ok || !r?.draft?.id) throw new Error(r?.error || 'foundry-generate returned no draft');
      // foundry-generate already SELECT-verifies its insert (write_proof). Link + approve.
      await supabase.from('action_queue').update({
        status: 'approved',
        payload: { ...item.payload, decided_at: new Date().toISOString(), draft_id: r.draft.id, draft_created: true, write_proof: r.write_proof, approval_error: null },
      }).eq('id', item.id);
      toast('Draft created → Workshop → Drafts');
    } catch (e) {
      // Do NOT approve. Keep in queue, surface the error.
      await supabase.from('action_queue').update({
        payload: { ...item.payload, approval_error: e instanceof Error ? e.message : String(e), error_at: new Date().toISOString() },
      }).eq('id', item.id);
      toast(`Draft generation FAILED — kept in queue: ${e instanceof Error ? e.message : e}`);
    }
    setBusy(null); load();
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
  const decidedCount = items.filter((it) => it.status !== 'proposed').length;
  let shown = items.filter((it) => filter === 'all' ? true : filter === 'initiatives' ? isInitiative(it) : !isInitiative(it));
  if (risk !== 'all') shown = shown.filter((it) => tierOf(it) === risk);
  // History (approved/rejected/done) is record, not a decision — hidden by default.
  if (!showHistory) shown = shown.filter((it) => it.status === 'proposed');
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
        <button className={filter === 'all' ? 'chip active' : 'chip'} onClick={() => setFilter('all')}>All ({items.filter((it) => it.status === 'proposed').length})</button>
        <button className={filter === 'initiatives' ? 'chip active' : 'chip'} onClick={() => setFilter('initiatives')}>◆ Silk's Initiatives ({initiativeCount})</button>
        <button className={filter === 'mat' ? 'chip active' : 'chip'} onClick={() => setFilter('mat')}>Mat-triggered</button>
      </div>
      <div className="subtabs">
        <span className="muted small" style={{ alignSelf: 'center' }}>risk:</span>
        <button className={risk === 'all' ? 'chip active' : 'chip'} onClick={() => setRisk('all')}>all</button>
        {(['grey', 'green', 'amber', 'red'] as Risk[]).map((t) => (
          <button key={t} className={risk === t ? 'chip active' : 'chip'} onClick={() => setRisk(t)}><span className={`risk-dot risk-${t}`} /> {t} ({riskCount(t)})</button>
        ))}
        {decidedCount > 0 && (
          <button className="link small" style={{ marginLeft: 'auto' }} onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'hide history' : `show history (${decidedCount})`}
          </button>
        )}
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
            {(it.payload as any).approval_error && <div className="risk-impact">⚠ Draft generation failed: {(it.payload as any).approval_error}. Approval NOT completed — fix and re-approve.</div>}
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
