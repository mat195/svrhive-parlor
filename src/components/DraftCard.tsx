import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { supabase } from '../lib/supabase';
import { callFn } from '../lib/api';
import { useToast } from './Toast';

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
  const [mode, setMode] = useState<'preview' | 'edit' | 'details'>('preview');
  const [editBody, setEditBody] = useState(stripFrontmatter(draft.markdown_body || ''));
  const [prevBody, setPrevBody] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [reviseNote, setReviseNote] = useState('');
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);
  const SpeechRec = typeof window !== 'undefined' ? ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition) : null;
  const [confirm, setConfirm] = useState<null | 'publish' | 'retract'>(null);
  const [countdown, setCountdown] = useState(3);
  const [stats, setStats] = useState<{ visits: number; cites: number } | null>(null);

  const isPublished = draft.status === 'published';
  const withinRetract = isPublished && draft.published_at && Date.now() - Date.parse(draft.published_at) < 15 * 60 * 1000;

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
  }, [draft.id, draft.status]);

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
  async function doRevise() {
    const note = reviseNote.trim();
    if (!note || busy) return;
    setBusy('revise'); setMsg('');
    try {
      const r = await callFn('foundry-revise', { draft_id: draft.id, note });
      if (!r?.ok) throw new Error(r?.error ?? 'revise failed');
      setReviseNote(''); toast(`Revised (v${r.version}) — ${r.changed_summary ?? 'updated'}`); onChange();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
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

      {!isPublished && (
        <>
          <div className="subtabs" style={{ marginTop: '0.6rem' }}>
            {(['preview', 'edit', 'details'] as const).map((m) => (
              <button key={m} className={mode === m ? 'chip active' : 'chip'} onClick={() => setMode(m)}>{m}</button>
            ))}
          </div>

          {mode === 'preview' && (
            draft.status === 'edited' && prevBody
              ? <div className="diff">{lineDiff(prevBody, draft.markdown_body || '').map((d, i) => <div key={i} className={d.sign === '+' ? 'add' : 'del'}>{d.sign} {d.text}</div>)}</div>
              : <div className="note-preview" dangerouslySetInnerHTML={{ __html: render(draft.markdown_body || '') }} />
          )}
          {mode === 'edit' && (
            <div className="editor">
              <textarea value={editBody} onChange={(e) => setEditBody(e.target.value)} rows={12} />
              <div className="note-preview" dangerouslySetInnerHTML={{ __html: render(editBody) }} />
              <button className="btn sm" disabled={busy === 'save'} onClick={saveEdit}>Save revision</button>
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

          <div className="revise-row">
            <input value={reviseNote} onChange={(e) => setReviseNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && reviseNote.trim()) doRevise(); }}
              placeholder="Tell Silk how to revise this — plain language…" disabled={busy === 'revise'} />
            {SpeechRec && <button type="button" className={`mic-btn ${listening ? 'live' : ''}`} onClick={toggleMic} title="Dictate">{listening ? '●' : '🎙'}</button>}
            <button className="btn sm" disabled={!reviseNote.trim() || busy === 'revise'} onClick={doRevise}>{busy === 'revise' ? 'Revising…' : 'Revise'}</button>
          </div>

          <div className="what-happens">
            <span className="risk-dot risk-red" /> <strong>If published (RED):</strong> commits {draft.filename} to the svrhive-site repo, GitHub Actions builds the site, live at {draft.live_url} in ~1–2 min. Retract available for 15 minutes after publish.
          </div>
          <div className="actions">
            <button className="btn sm" disabled={!!busy} onClick={() => setConfirm('publish')}>Publish</button>
            <button className="btn sm ghost" disabled={!!busy} onClick={doReject}>Reject</button>
            <button className="btn sm ghost" disabled={!!busy} onClick={doRegenerate}>{busy === 'regen' ? 'Regenerating…' : 'Regenerate'}</button>
          </div>
        </>
      )}

      {isPublished && (
        <div className="published">
          <p>Live at <a href={draft.live_url ?? '#'} target="_blank" rel="noopener">{draft.live_url}</a></p>
          <p className="muted small">
            published {String(draft.published_at).slice(0, 16).replace('T', ' ')}
            {stats && ` · ${stats.visits} visits · ${stats.cites} citing prompts`}
          </p>
          {withinRetract
            ? <button className="btn sm ghost" disabled={!!busy} onClick={() => setConfirm('retract')}>Retract (15-min window)</button>
            : <button className="btn sm ghost" disabled={!!busy} onClick={() => setConfirm('retract')}>Retract (past window)</button>}
        </div>
      )}

      {msg && <p className="small" style={{ marginTop: '0.5rem' }}>{msg}</p>}

      {confirm && (
        <div className="modal-backdrop" onClick={() => setConfirm(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <p><strong>{confirm === 'publish' ? 'Publish to silkvelvetrecords.com?' : 'Retract this page?'}</strong></p>
            <p className="muted small">{confirm === 'publish' ? draft.live_url : 'Removes the note from the live site.'}</p>
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
