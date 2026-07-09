import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { buildPreviewDoc } from '../lib/sitePreview';
import { useSilk } from '../SilkContext';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import { useToast } from './Toast';
import CollaboratorPanel from './CollaboratorPanel';

// Derived, human status (item 4): what does this draft need from Mat?
function draftStatus(d: Draft): { label: string; cls: string } {
  if (d.status === 'published') return { label: 'published', cls: 'chip ok' };
  if (d.status === 'retracted' || d.status === 'rejected') return { label: d.status, cls: 'chip err' };
  if (/\[MAT:/.test(d.markdown_body ?? '')) return { label: 'waiting on Mat inputs', cls: 'chip warn' };
  if (d.status === 'edited') return { label: 'ready', cls: 'chip ok' };
  return { label: 'proposed by Silk', cls: 'chip' };
}

export interface Draft {
  id: string; created_at: string; target_query: string; category: string | null;
  competitor_urls: string[]; rationale: string | null; silk_explains: string | null;
  filename: string | null; markdown_body: string | null; status: string;
  mat_note: string | null; ledger_refs: any[]; commit_sha: string | null;
  live_url: string | null; published_at: string | null; retracted_at: string | null;
  updated_at: string | null;
}

const STATUS_CLASS: Record<string, string> = {
  proposed: 'chip', edited: 'chip', published: 'chip ok', retracted: 'chip err', rejected: 'chip err',
};

function stripFrontmatter(md: string): string {
  return (md || '').replace(/^---[\s\S]*?---\n?/, '');
}
function render(md: string): string {
  return marked.parse(stripFrontmatter(md), { async: false }) as string;
}
function lineDiff(prev: string, curr: string): { sign: string; text: string }[] {
  const a = new Set(stripFrontmatter(prev).split('\n'));
  const b = new Set(stripFrontmatter(curr).split('\n'));
  const out: { sign: string; text: string }[] = [];
  for (const l of stripFrontmatter(curr).split('\n')) if (!a.has(l) && l.trim()) out.push({ sign: '+', text: l });
  for (const l of stripFrontmatter(prev).split('\n')) if (!b.has(l) && l.trim()) out.push({ sign: '-', text: l });
  return out;
}

export default function DraftCard({ draft, onChange }: { draft: Draft; onChange: () => void }) {
  const toast = useToast();
  const { discussDraft, pinnedDraft } = useSilk();
  const [mode, setMode] = useState<'preview' | 'collaborators' | 'structure' | 'edit' | 'details'>('preview');
  const [editBody, setEditBody] = useState(stripFrontmatter(draft.markdown_body || ''));
  const [prevBody, setPrevBody] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [reviseNote, setReviseNote] = useState('');
  const [reviseFeedback, setReviseFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [previewBody, setPreviewBody] = useState('');
  // Debounce the live preview so the iframe doesn't reload on every keystroke.
  useEffect(() => { const t = setTimeout(() => setPreviewBody(editBody), 250); return () => clearTimeout(t); }, [editBody]);
  const [fills, setFills] = useState<Record<string, string>>({});
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);
  const SpeechRec = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
  const [confirm, setConfirm] = useState<null | 'publish' | 'retract'>(null);
  const [countdown, setCountdown] = useState(3);
  const [stats, setStats] = useState<{ visits: number; cites: number } | null>(null);

  const isPublished = draft.status === 'published';
  const withinRetract = isPublished && draft.published_at && Date.now() - Date.parse(draft.published_at) < 15 * 60 * 1000;
  // A page that is live (published) OR was published and is now being revised in place.
  const wasPublished = !!draft.published_at && draft.status !== 'retracted';
  const revisingLive = draft.status === 'edited' && wasPublished;   // live page, edits pending republish
  const editable = draft.status !== 'retracted' && draft.status !== 'rejected';

  // Load prior version (for diff) + published stats.
  useEffect(() => {
    if (draft.status === 'edited') {
      supabase.from('corpus_draft_versions').select('markdown_body').eq('draft_id', draft.id).order('version', { ascending: false }).limit(1)
        .then(({ data }) => setPrevBody(data?.[0]?.markdown_body ?? null));
    }
    if (isPublished) {
      (async () => {
        const path = draft.live_url ? new URL(draft.live_url).pathname : null;
        const v = path ? await supabase.from('site_visits').select('id', { count: 'exact', head: true }).eq('path', path) : { count: 0 };
        // Battery citations mentioning THIS URL (visibility_results.citations array).
        const c = draft.live_url ? await supabase.from('visibility_results').select('id', { count: 'exact', head: true }).contains('citations', [draft.live_url]) : { count: 0 };
        setStats({ visits: v.count ?? 0, cites: c.count ?? 0 });
      })();
    }
  }, [draft.id, draft.status, draft.updated_at]);

  // Publish/Retract confirm countdown.
  useEffect(() => {
    if (!confirm) return;
    setCountdown(3);
    const t = setInterval(() => setCountdown((c) => (c <= 1 ? (clearInterval(t), 0) : c - 1)), 1000);
    return () => clearInterval(t);
  }, [confirm]);

  async function doPublish() {
    setBusy('publish'); setMsg(''); setConfirm(null);
    try {
      const r = await callFn('foundry-publish', { draft_id: draft.id });
      setMsg(r.stubbed ? `⚠ ${r.error}` : `Publishing → ${r.live_url} (live in ~1–2 min)`);
      if (!r.stubbed) onChange();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  }
  async function doRetract() {
    setBusy('retract'); setMsg(''); setConfirm(null);
    const afterWindow = !withinRetract; // past the 15-min window → recorded distinctly
    try {
      const r = await callFn('foundry-retract', { draft_id: draft.id, after_window: afterWindow });
      setMsg(r.stubbed ? `⚠ ${r.error}` : 'Retracted.');
      if (!r.stubbed) {
        onChange();
        toast(afterWindow ? 'Retracted (past window)' : 'Retracted', async () => { await callFn('foundry-publish', { draft_id: draft.id }); onChange(); });
      }
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  }
  async function doReject() {
    const note = window.prompt('Reason for rejecting (optional):') ?? '';
    setBusy('reject');
    await supabase.from('corpus_drafts').update({ status: 'rejected', mat_note: note, updated_at: new Date().toISOString() }).eq('id', draft.id);
    setBusy(''); onChange();
  }
  // Item 3: fill a [MAT: …] placeholder inline — Mat types his take, we splice it into
  // the markdown deterministically (no LLM). When none remain, status flips to ready.
  async function fillPlaceholder(ph: string) {
    const val = (fills[ph] ?? '').trim();
    if (!val || busy) return;
    setBusy('fill');
    const newBody = (draft.markdown_body ?? '').split(ph).join(val);
    await supabase.from('corpus_drafts').update({ markdown_body: newBody, status: draft.status === 'proposed' ? 'edited' : draft.status, updated_at: new Date().toISOString() }).eq('id', draft.id);
    setFills((f) => { const n = { ...f }; delete n[ph]; return n; });
    setBusy(''); onChange();
  }
  // Item 2: deterministic list/table row controls — reorder/delete/pin without an LLM.
  function editBlockRow(action: 'up' | 'down' | 'del' | 'pin', blockStart: number, rowIdx: number) {
    const lines = (draft.markdown_body ?? '').split('\n');
    // find the contiguous block of table/list rows starting at blockStart
    const isRow = (l: string) => /^\s*\|/.test(l) || /^\s*[-*+]\s+/.test(l);
    let end = blockStart; while (end + 1 < lines.length && isRow(lines[end + 1])) end++;
    const block = lines.slice(blockStart, end + 1);
    const isTable = /^\s*\|/.test(block[0]);
    const headerCount = isTable ? 2 : 0; // table: header row + separator stay put
    const head = block.slice(0, headerCount);
    const rows = block.slice(headerCount);
    if (rowIdx < 0 || rowIdx >= rows.length) return;
    if (action === 'del') rows.splice(rowIdx, 1);
    else if (action === 'pin') { const [r] = rows.splice(rowIdx, 1); rows.unshift(r); }
    else if (action === 'up' && rowIdx > 0) { [rows[rowIdx - 1], rows[rowIdx]] = [rows[rowIdx], rows[rowIdx - 1]]; }
    else if (action === 'down' && rowIdx < rows.length - 1) { [rows[rowIdx + 1], rows[rowIdx]] = [rows[rowIdx], rows[rowIdx + 1]]; }
    const newLines = [...lines.slice(0, blockStart), ...head, ...rows, ...lines.slice(end + 1)];
    supabase.from('corpus_drafts').update({ markdown_body: newLines.join('\n'), status: draft.status === 'proposed' ? 'edited' : draft.status, updated_at: new Date().toISOString() }).eq('id', draft.id).then(() => onChange());
  }
  async function doRevise() {
    const note = reviseNote.trim();
    if (!note || busy) return;
    setBusy('revise'); setMsg(''); setReviseFeedback(null);
    try {
      const r = await callFn('foundry-revise', { draft_id: draft.id, note });
      if (!r?.ok) throw new Error(r?.error ?? 'revise failed');
      setReviseNote('');
      setMode('preview'); // surface the updated content (diff view) immediately
      setReviseFeedback({ kind: 'ok', text: `Revised to v${r.version} — ${r.changed_summary ?? 'updated'}` });
      toast(`Revised (v${r.version})`);
      onChange(); // re-fetch so the draft prop (and diff) reflect the new body
    } catch (e) {
      setReviseFeedback({ kind: 'err', text: `Revision failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    setBusy('');
  }
  function toggleMic() {
    if (!SpeechRec) return;
    if (listening) { recogRef.current?.stop(); return; }
    const r = new SpeechRec();
    r.lang = 'en-US'; r.interimResults = true; r.continuous = false;
    const base = reviseNote ? reviseNote + ' ' : '';
    r.onresult = (e: any) => { let t = ''; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; setReviseNote(base + t); };
    r.onend = () => setListening(false); r.onerror = () => setListening(false);
    recogRef.current = r; setListening(true); r.start();
  }
  async function doRegenerate() {
    setBusy('regen'); setMsg('');
    try { await callFn('foundry-generate', { target_query: draft.target_query }); onChange(); }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  }
  // Quick edit (no LLM): open the raw-markdown editor seeded with the CURRENT body, so a
  // typo / wrong word / date fix is a direct inline edit saved instantly.
  function startQuickEdit() {
    setEditBody(stripFrontmatter(draft.markdown_body || ''));
    setMode('edit');
  }
  async function saveEdit() {
    setBusy('save');
    const { data: vers } = await supabase.from('corpus_draft_versions').select('version').eq('draft_id', draft.id).order('version', { ascending: false }).limit(1);
    const nextV = (vers?.[0]?.version ?? 0) + 1;
    await supabase.from('corpus_draft_versions').insert({ draft_id: draft.id, version: nextV, markdown_body: draft.markdown_body });
    const fmMatch = (draft.markdown_body || '').match(/^---[\s\S]*?---\n?/);
    const fm = fmMatch ? fmMatch[0] : '';
    await supabase.from('corpus_drafts').update({ markdown_body: fm + editBody, status: 'edited', updated_at: new Date().toISOString() }).eq('id', draft.id);
    setBusy(''); setMode('preview'); onChange();
  }

  return (
    <div className="card draftcard">
      <div className="row-head">
        {(() => { const s = draftStatus(draft); return <span className={s.cls}>{s.label}</span>; })()}
        <span className="muted small">{draft.filename} · {String(draft.created_at).slice(0, 10)}</span>
      </div>
      <div className="draft-query">{draft.target_query}</div>
      {draft.silk_explains && <div className="silk-explains">“{draft.silk_explains}”</div>}

      {isPublished && (
        <div className="live-banner">
          ● Live at <a href={draft.live_url ?? '#'} target="_blank" rel="noopener">{draft.live_url}</a>
          <span className="muted small"> · published {String(draft.published_at).slice(0, 16).replace('T', ' ')}{stats && ` · ${stats.visits} visits · ${stats.cites} citing prompts`}</span>
          <div className="muted small">Small fix? Quick Edit or Revise below — no need to retract.</div>
        </div>
      )}
      {revisingLive && (
        <div className="live-banner editing">✎ Revising a LIVE page — <strong>Publish update</strong> replaces it in place (same URL, new last-modified date). No retract/redraft needed.</div>
      )}

      {editable && (() => {
        const placeholders = isPublished || revisingLive ? [] : [...new Set([...(draft.markdown_body ?? '').matchAll(/\[MAT:[^\]]*\]/g)].map((m) => m[0]))];
        return (
        <>
          {placeholders.length > 0 && (
            <div className="mat-inputs">
              <div className="moment-label">Silk needs your take ({placeholders.length})</div>
              {placeholders.map((ph) => (
                <div key={ph} className="mat-input-row">
                  <span className="muted small">{ph}</span>
                  <input value={fills[ph] ?? ''} onChange={(e) => setFills((f) => ({ ...f, [ph]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter' && fills[ph]?.trim()) fillPlaceholder(ph); }} placeholder="Your take…" />
                  <button className="btn sm" disabled={!fills[ph]?.trim() || busy === 'fill'} onClick={() => fillPlaceholder(ph)}>Save</button>
                </div>
              ))}
            </div>
          )}
          <div className="subtabs" style={{ marginTop: '0.6rem' }}>
            {(['preview', 'collaborators', 'structure', 'edit', 'details'] as const).map((m) => (
              <button key={m} className={mode === m ? 'chip active' : 'chip'} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>

          {mode === 'collaborators' && <CollaboratorPanel draftId={draft.id} onChange={onChange} />}

          {mode === 'preview' && (
            draft.status === 'edited' && prevBody
              ? <div className="diff">{lineDiff(prevBody, draft.markdown_body || '').map((d, i) => <div key={i} className={d.sign === '+' ? 'add' : 'del'}>{d.sign} {d.text}</div>)}</div>
              : <div className="note-preview" dangerouslySetInnerHTML={{ __html: render(draft.markdown_body || '') }} />
          )}
          {mode === 'structure' && (() => {
            const lines = stripFrontmatter(draft.markdown_body || '').split('\n');
            const isRow = (l: string) => /^\s*\|/.test(l) || /^\s*[-*+]\s+/.test(l);
            // map structure-view line index → real markdown line index (frontmatter offset)
            const fmLines = ((draft.markdown_body || '').match(/^---[\s\S]*?---\n?/)?.[0].split('\n').length ?? 1) - 1;
            const blocks: { start: number; isTable: boolean; rows: { text: string; idx: number }[] }[] = [];
            for (let i = 0; i < lines.length; i++) {
              if (isRow(lines[i]) && (i === 0 || !isRow(lines[i - 1]))) {
                let end = i; while (end + 1 < lines.length && isRow(lines[end + 1])) end++;
                const isTable = /^\s*\|/.test(lines[i]);
                const rows = lines.slice(i + (isTable ? 2 : 0), end + 1).map((text, idx) => ({ text, idx }));
                if (rows.length) blocks.push({ start: i + fmLines, isTable, rows });
                i = end;
              }
            }
            if (!blocks.length) return <p className="muted small">No lists or tables to reorder.</p>;
            return (
              <div className="structure">
                <p className="muted small">Reorder / remove rows — saves instantly, no AI.</p>
                {blocks.map((b, bi) => (
                  <div key={bi} className="struct-block">
                    {b.rows.map((r) => (
                      <div key={r.idx} className="struct-row">
                        <span className="struct-cell">{r.text.replace(/^\s*[|*+-]\s*/, '').replace(/\|/g, ' · ').slice(0, 70)}</span>
                        <span className="struct-ctrls">
                          <button title="Pin to top" onClick={() => editBlockRow('pin', b.start, r.idx)}>⤒</button>
                          <button title="Up" onClick={() => editBlockRow('up', b.start, r.idx)}>↑</button>
                          <button title="Down" onClick={() => editBlockRow('down', b.start, r.idx)}>↓</button>
                          <button title="Remove" onClick={() => editBlockRow('del', b.start, r.idx)}>✕</button>
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            );
          })()}
          {mode === 'edit' && (
            <div className="editor">
              <div className="qe-split">
                <label className="qe-pane">
                  <span className="qe-pane-label">Markdown</span>
                  <textarea className="qe-md" value={editBody} onChange={(e) => setEditBody(e.target.value)} spellCheck={true} />
                </label>
                <div className="qe-pane">
                  <span className="qe-pane-label">Live page preview</span>
                  <iframe className="qe-preview" title="Live rendered preview of the published page" srcDoc={buildPreviewDoc(render(previewBody))} />
                </div>
              </div>
              <div className="qe-actions">
                <button className="btn sm" disabled={busy === 'save'} onClick={saveEdit}>Save revision</button>
                <span className="muted small">Preview uses the real page's fonts &amp; styling — this is how it'll publish.</span>
              </div>
            </div>
          )}
          {mode === 'details' && (
            <div className="details small">
              {draft.rationale && <p>{draft.rationale}</p>}
              <p className="muted">Expected URL: {draft.live_url}</p>
              {draft.competitor_urls?.length > 0 && <>
                <p className="muted">Competitor URLs winning this query:</p>
                <ul className="linklist">{draft.competitor_urls.map((u) => <li key={u}><a href={u} target="_blank" rel="noopener">{u}</a></li>)}</ul>
              </>}
              {draft.ledger_refs?.length > 0 && <p className="muted">Sourced from: {draft.ledger_refs.map((r: any) => r.kind).join(', ')}</p>}
            </div>
          )}

          <div className="revise-lead">
            <button className="btn sm" onClick={() => discussDraft({ id: draft.id, target_query: draft.target_query })}>
              {pinnedDraft?.id === draft.id ? '💬 Discussing in Silk chat →' : '💬 Discuss this draft with Silk →'}
            </button>
            <span className="muted small">Recommended for anything involving wording or judgment — talk it through, then Silk applies the change.</span>
          </div>
          <div className="revise-row">
            <input value={reviseNote} onChange={(e) => setReviseNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && reviseNote.trim()) doRevise(); }}
              placeholder="…or a quick one-shot fix (a date, a name swap)" disabled={busy === 'revise'} />
            {SpeechRec && <button type="button" className={`mic-btn ${listening ? 'live' : ''}`} onClick={toggleMic} title="Dictate">{listening ? '●' : '🎙'}</button>}
            <button className="btn sm" disabled={!reviseNote.trim() || busy === 'revise'} onClick={doRevise}>{busy === 'revise' ? 'Revising…' : 'Revise'}</button>
          </div>
          {busy === 'revise' && <div className="revise-status working"><span className="pulse" /> Silk is rewriting the page — usually ~10 seconds…</div>}
          {busy !== 'revise' && reviseFeedback && <div className={`revise-status ${reviseFeedback.kind}`}>{reviseFeedback.kind === 'ok' ? '✓ ' : '⚠ '}{reviseFeedback.text}</div>}

          {!isPublished && (
            <div className="what-happens">
              <span className="risk-dot risk-red" /> <strong>{revisingLive ? 'Publish update (RED):' : 'If published (RED):'}</strong>{' '}
              {revisingLive
                ? <>replaces the live page {draft.filename} in place — same URL ({draft.live_url}), refreshed content and last-modified date. Retract available for 15 minutes after.</>
                : <>commits {draft.filename} to the svrhive-site repo, GitHub Actions builds the site, live at {draft.live_url} in ~1–2 min. Retract available for 15 minutes after publish.</>}
            </div>
          )}
          {/* Primary actions — light-touch first: Quick Edit, Revise (row above), then Publish/Retract. */}
          <div className="actions">
            <button className="btn sm" disabled={!!busy} onClick={startQuickEdit}>Quick Edit</button>
            {isPublished
              ? <button className="btn sm ghost" disabled={!!busy} onClick={() => setConfirm('retract')}>Retract</button>
              : <button className="btn sm" disabled={!!busy} onClick={() => setConfirm('publish')}>{revisingLive ? 'Publish update' : 'Publish'}</button>}
          </div>
          {/* Secondary / demoted — reject only for never-published drafts. */}
          <div className="actions-secondary small">
            {!wasPublished && <button className="linklike danger" disabled={!!busy} onClick={doReject}>Reject</button>}
            <button className="linklike" disabled={!!busy} onClick={doRegenerate}>{busy === 'regen' ? 'Regenerating…' : 'Regenerate from scratch'}</button>
          </div>
        </>
        );
      })()}

      {!editable && (
        <p className="muted small" style={{ marginTop: '0.4rem' }}>
          {draft.status === 'retracted' ? 'Retracted from the live site.' : 'Rejected.'}
          {draft.mat_note ? ` — “${draft.mat_note}”` : ''}
        </p>
      )}

      {msg && <p className="small" style={{ marginTop: '0.5rem' }}>{msg}</p>}

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p><strong>{confirm === 'publish' ? (revisingLive ? 'Publish update to the live page?' : 'Publish to silkvelvetrecords.com?') : 'Retract this page?'}</strong></p>
            <p className="muted small">{confirm === 'publish' ? (revisingLive ? `Updates ${draft.live_url} in place — same URL.` : draft.live_url) : 'Removes the note from the live site.'}</p>
            <div className="actions">
              <button className="btn" disabled={countdown > 0} onClick={confirm === 'publish' ? doPublish : doRetract}>
                {countdown > 0 ? `${countdown}…` : confirm === 'publish' ? 'Publish now' : 'Retract now'}
              </button>
              <button className="btn ghost" onClick={() => setConfirm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
