import { useEffect, useRef, useState } from 'react';
import { callFn } from '../lib/api';

// The dedicated "swap these names for those" surface. Every named collaborator is a
// removable chip; "+ Add" autocompletes against §7/§6 and verifies before adding. Both
// add and remove trigger ONE section-scoped foundry-collab pass (small diff), so the rest
// of the page is untouched. Refuses silently on unverifiable names, same as the foundry.
type Collab = { name: string; section: string };
const SECTIONS = ['Montréal scene', 'Recurring collaborators', 'Notable features'];

export default function CollaboratorPanel({ draftId, onChange }: { draftId: string; onChange: () => void }) {
  const [list, setList] = useState<Collab[]>([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [addName, setAddName] = useState('');
  const [sugg, setSugg] = useState<{ name: string; section: string; verified: boolean }[]>([]);
  const [pendingTrack, setPendingTrack] = useState<string | null>(null);
  const [trackInput, setTrackInput] = useState('');
  const [diff, setDiff] = useState<{ summary: string; before: string; after: string } | null>(null);
  const debounce = useRef<number | undefined>(undefined);

  const load = () => callFn('foundry-collab', { draft_id: draftId, action: 'list' }).then((r) => setList(r.collaborators ?? [])).catch(() => {});
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [draftId]);

  useEffect(() => {
    if (addName.trim().length < 2) { setSugg([]); return; }
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      try { const r = await callFn('foundry-collab', { draft_id: draftId, action: 'suggest', name: addName.trim() }); setSugg(r.candidates ?? []); } catch { setSugg([]); }
    }, 250);
    return () => window.clearTimeout(debounce.current);
  }, [addName, draftId]);

  async function remove(name: string) {
    setBusy(name); setMsg('');
    try {
      const r = await callFn('foundry-collab', { draft_id: draftId, action: 'remove', name });
      if (r.ok) { setDiff({ summary: r.summary, before: r.old_section, after: r.new_section }); await load(); onChange(); }
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  }

  async function tryAdd(name: string) {
    setBusy('add'); setMsg(''); setSugg([]);
    try {
      const res = await callFn('foundry-collab', { draft_id: draftId, action: 'resolve', name });
      if (res.status === 'verified') { await doAdd(name); return; }
      setPendingTrack(name); // needs a track → prompt
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  }

  async function doAdd(name: string, track?: string) {
    setBusy('add'); setMsg('');
    try {
      const r = await callFn('foundry-collab', { draft_id: draftId, action: 'add', name, track });
      if (r.ok) { setDiff({ summary: r.summary, before: '', after: r.new_section }); setAddName(''); setPendingTrack(null); setTrackInput(''); await load(); onChange(); }
      else if (r.refused) setMsg(`⚠ ${r.reason}`);
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  }

  return (
    <div className="collab-panel">
      <p className="muted small">Add or remove a named collaborator — verified against the entity master, one scoped revise, small diff.</p>

      {SECTIONS.map((sec) => {
        const rows = list.filter((c) => c.section === sec);
        if (!rows.length) return null;
        return (
          <div key={sec} className="collab-group">
            <div className="collab-group-label">{sec}</div>
            <div className="collab-chips">
              {rows.map((c) => (
                <span key={c.name} className="collab-chip">
                  {c.name}
                  <button className="collab-x" disabled={!!busy} title={`Remove ${c.name}`} onClick={() => remove(c.name)}>{busy === c.name ? '…' : '×'}</button>
                </span>
              ))}
            </div>
          </div>
        );
      })}

      <div className="collab-add">
        <input value={addName} onChange={(e) => setAddName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && addName.trim()) tryAdd(addName.trim()); }}
          placeholder="+ Add collaborator (type a name)…" disabled={busy === 'add'} />
        {sugg.length > 0 && (
          <div className="collab-suggest">
            {sugg.map((s) => (
              <button key={s.name} className="collab-suggest-item" onClick={() => tryAdd(s.name)}>
                {s.name} <span className="muted small">{s.section}{s.verified ? '' : ' · unverified'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {pendingTrack && (
        <div className="collab-track">
          <span className="small">“{pendingTrack}” isn’t in §7/§6 — track title to verify:</span>
          <input value={trackInput} onChange={(e) => setTrackInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && trackInput.trim()) doAdd(pendingTrack, trackInput.trim()); }}
            placeholder="Track title…" />
          <button className="btn sm" disabled={!trackInput.trim() || busy === 'add'} onClick={() => doAdd(pendingTrack, trackInput.trim())}>Verify & add</button>
          <button className="linklike" onClick={() => { setPendingTrack(null); setTrackInput(''); }}>cancel</button>
        </div>
      )}

      {msg && <p className="small" style={{ marginTop: '0.4rem' }}>{msg}</p>}
      {diff && (
        <div className="collab-diff">
          <div className="muted small">✓ {diff.summary} — section updated:</div>
          <pre>{diff.after}</pre>
        </div>
      )}
    </div>
  );
}
