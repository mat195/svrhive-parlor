import { useEffect, useMemo, useState } from 'react';
import { marked } from 'marked';
import { supabase } from '../lib/supabase';

// Rules — an easy, always-available view of Silk's live rulebooks, read straight from
// silk_config (the same runtime source every Silk call uses). What you see here is
// exactly what binds Silk's behavior right now.
interface Cfg { key: string; value: string; hash: string; updated_at: string }

function label(key: string): { group: string; name: string } {
  if (key === 'silk_identity') return { group: 'Identity', name: 'SILK_IDENTITY (core rules)' };
  if (key === 'entity_master') return { group: 'Facts', name: 'Entity master (LPT canonical facts)' };
  if (key === 'distill_doctrine') return { group: 'Rulebooks', name: 'conversation-distillation' };
  if (key.startsWith('skill:')) return { group: 'Rulebooks', name: key.slice(6) };
  if (key.startsWith('file:')) return { group: 'Config', name: key.slice(5) };
  return { group: 'Other', name: key };
}

export default function Rules() {
  const [cfgs, setCfgs] = useState<Cfg[] | null>(null);
  const [openKey, setOpenKey] = useState<string | null>('silk_identity');
  const [q, setQ] = useState('');

  useEffect(() => {
    supabase.from('silk_config').select('key, value, hash, updated_at').order('key')
      // Dedupe: distill_doctrine is the same file as skill:conversation-distillation.
      .then(({ data }) => setCfgs(((data as Cfg[]) ?? []).filter((c) => c.key !== 'distill_doctrine')));
  }, []);

  const groups = useMemo(() => {
    const g: Record<string, Cfg[]> = {};
    for (const c of cfgs ?? []) {
      if (q && !label(c.key).name.toLowerCase().includes(q.toLowerCase()) && !(c.value ?? '').toLowerCase().includes(q.toLowerCase())) continue;
      const grp = label(c.key).group;
      (g[grp] = g[grp] ?? []).push(c);
    }
    return g;
  }, [cfgs, q]);

  if (!cfgs) return <p className="muted">Loading…</p>;
  const open = cfgs.find((c) => c.key === openKey);
  const isMd = open && !open.key.startsWith('file:');

  return (
    <div className="rules-view">
      <aside className="rules-index">
        <input className="rules-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search rules…" />
        {['Identity', 'Facts', 'Rulebooks', 'Config', 'Other'].filter((g) => groups[g]?.length).map((g) => (
          <div key={g} className="rules-group">
            <div className="rules-group-label">{g}</div>
            {groups[g].map((c) => (
              <button key={c.key} className={c.key === openKey ? 'rules-item active' : 'rules-item'} onClick={() => setOpenKey(c.key)}>
                <span>{label(c.key).name}</span>
                <span className="muted" style={{ fontSize: '0.62rem' }}>{String(c.updated_at).slice(0, 10)}</span>
              </button>
            ))}
          </div>
        ))}
      </aside>
      <section className="rules-content">
        {open ? (
          <>
            <div className="rules-head">
              <strong>{label(open.key).name}</strong>
              <span className="muted small">rules <code>{open.hash}</code> · updated {String(open.updated_at).slice(0, 16).replace('T', ' ')}</span>
            </div>
            {isMd
              ? <div className="note-preview" dangerouslySetInnerHTML={{ __html: marked.parse(open.value ?? '', { async: false }) as string }} />
              : <pre className="rules-raw">{open.value}</pre>}
          </>
        ) : <p className="muted">Select a rulebook.</p>}
      </section>
    </div>
  );
}
