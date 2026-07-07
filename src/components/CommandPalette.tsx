import { useEffect, useMemo, useRef, useState } from 'react';
import { useSilk, type Room } from '../SilkContext';
import { catalog } from '../lib/brainData';

// Cmd/Ctrl+K command palette — fuzzy search over Parlor actions.
interface Cmd { label: string; hint?: string; run: () => void }

// Subsequence fuzzy match + simple score (earlier + contiguous = better).
function fuzzy(q: string, s: string): number | null {
  if (!q) return 0;
  const ql = q.toLowerCase(), sl = s.toLowerCase();
  let i = 0, score = 0, last = -1;
  for (let j = 0; j < sl.length && i < ql.length; j++) {
    if (sl[j] === ql[i]) { score += last === j - 1 ? 2 : 1; last = j; i++; }
  }
  return i === ql.length ? score - sl.length * 0.01 : null;
}

const ROOMS: Room[] = ['brief', 'ledger', 'brain', 'workshop', 'watchtower', 'archive'];

export default function CommandPalette() {
  const { setRoom, setFocusNode, newChat } = useSilk();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (open) { setQ(''); setSel(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const openWorkshop = (tab: string) => { localStorage.setItem('workshop_tab', tab); setRoom('workshop'); setOpen(false); };

  const commands = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [
      ...ROOMS.map((r) => ({ label: `Go to ${r[0].toUpperCase() + r.slice(1)}`, hint: 'room', run: () => { setRoom(r); setOpen(false); } })),
      { label: 'Start new chat', hint: 'Silk', run: () => { newChat(); setOpen(false); } },
      { label: 'Open Workshop → Drafts', hint: 'workshop', run: () => openWorkshop('drafts') },
      { label: 'Open Workshop → Actions (queue)', hint: 'workshop', run: () => openWorkshop('actions') },
      { label: "Open Workshop → Silk's Initiatives", hint: 'workshop', run: () => { localStorage.setItem('workshop_filter', 'initiatives'); openWorkshop('actions'); } },
      { label: 'Open Ledger → Assemblies (retrieval debug)', hint: 'ledger', run: () => { localStorage.setItem('ledger_tab', 'assemblies'); setRoom('ledger'); setOpen(false); } },
    ];
    for (const rel of catalog.filter((n) => n.key.startsWith('rel-'))) {
      list.push({ label: `Jump to release — ${rel.label}`, hint: 'catalog', run: () => { setRoom('brain'); setFocusNode(rel.key); setOpen(false); } });
    }
    return list;
  }, [setRoom, setFocusNode, newChat]);

  const results = useMemo(() => commands
    .map((c) => ({ c, s: fuzzy(q, c.label + ' ' + (c.hint ?? '')) }))
    .filter((r) => r.s !== null)
    .sort((a, b) => (b.s! - a.s!))
    .slice(0, 8), [q, commands]);

  if (!open) return null;
  return (
    <div className="cmdk-backdrop" onClick={() => setOpen(false)}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <input ref={inputRef} value={q} placeholder="Type a command…"
          onChange={(e) => { setQ(e.target.value); setSel(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, results.length - 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
            if (e.key === 'Enter') { e.preventDefault(); results[sel]?.c.run(); }
          }} />
        <ul className="cmdk-list">
          {results.length === 0 && <li className="cmdk-empty muted">No commands</li>}
          {results.map((r, i) => (
            <li key={r.c.label}>
              <button className={i === sel ? 'active' : ''} onMouseEnter={() => setSel(i)} onClick={() => r.c.run()}>
                <span>{r.c.label}</span>{r.c.hint && <span className="muted small">{r.c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
