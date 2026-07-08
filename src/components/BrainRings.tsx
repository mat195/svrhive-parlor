import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';
import { buildDirectory, type ReleaseLite } from '../lib/collab';
import { platforms as PLATFORMS } from '../lib/brainData';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const money = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : String(n));

interface Member { label: string; sub?: string; onClick: () => void; href?: string }
interface Ring { key: string; label: string; count: string; members: Member[] }

// Six hubs on a hexagon around the centre. angle 0 = top, clockwise.
const R = 37;
const pos = (i: number, n = 6) => { const a = (i / n) * 2 * Math.PI; return { x: 50 + R * Math.sin(a), y: 50 - R * Math.cos(a) }; };

export default function BrainRings() {
  const { setRoom, setFocusNode } = useSilk();
  const [rings, setRings] = useState<Ring[] | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  const goLedgerCatalog = () => { localStorage.setItem('ledger_tab', 'catalog'); setRoom('ledger'); };
  const goWorkshop = (tab: string) => { localStorage.setItem('workshop_tab', tab); setRoom('workshop'); };

  useEffect(() => {
    (async () => {
      const [rel, corpus, wiz, prog, met] = await Promise.all([
        supabase.from('releases').select('id, title, catalog_number, release_date, tier, streams, label_credit, spotify_album_id'),
        supabase.from('corpus_drafts').select('status, target_query, live_url, filename'),
        supabase.from('listing_wizards').select('key, title, platform, steps').order('order_index'),
        supabase.from('listing_progress').select('wizard_key, done_steps'),
        supabase.from('metrics_snapshots').select('metric, value, captured_at').order('captured_at', { ascending: false }),
      ]);
      const releases = (rel.data as ReleaseLite[]) ?? [];
      const dir = buildDirectory(releases).sort((a, b) => b.combinedStreams - a.combinedStreams);
      const topRel = [...releases].sort((a, b) => Number(b.streams ?? 0) - Number(a.streams ?? 0));
      const drafts = corpus.data ?? [];
      const published = drafts.filter((d: any) => d.status === 'published');
      const wizards = wiz.data ?? [];
      const progress = new Map((prog.data ?? []).map((p: any) => [p.wizard_key, (p.done_steps ?? []).length]));
      // latest snapshot per metric
      const latestMetric = new Map<string, any>();
      for (const m of met.data ?? []) if (!latestMetric.has(m.metric)) latestMetric.set(m.metric, m);

      setRings([
        {
          key: 'collaborators', label: 'Collaborators', count: `${dir.length}`,
          members: dir.slice(0, 10).map((c) => ({
            label: c.name, sub: `${c.trackCount} track${c.trackCount !== 1 ? 's' : ''} · ${money(c.combinedStreams)}`,
            onClick: () => { setFocusNode(`collab-${slug(c.name)}`); setRoom('people'); },
          })),
        },
        {
          key: 'releases', label: 'Releases', count: `${releases.length}`,
          members: topRel.slice(0, 10).map((r) => ({
            label: r.title, sub: `${r.catalog_number ?? ''} · ${money(Number(r.streams ?? 0))}`,
            onClick: goLedgerCatalog, href: r.spotify_album_id ? `https://open.spotify.com/album/${r.spotify_album_id}` : undefined,
          })),
        },
        {
          key: 'platforms', label: 'Platforms', count: `${PLATFORMS.filter((p) => !p.missing).length}`,
          members: PLATFORMS.filter((p) => !p.missing).map((p) => ({ label: p.label, sub: p.confidence, onClick: () => {}, href: p.url })),
        },
        {
          key: 'corpus', label: 'Corpus Pages', count: `${published.length}/${drafts.length}`,
          members: drafts.slice(0, 12).map((d: any) => ({
            label: d.target_query ?? d.filename ?? 'page', sub: d.status,
            onClick: () => goWorkshop('drafts'), href: d.status === 'published' && d.live_url ? d.live_url : undefined,
          })),
        },
        {
          key: 'kits', label: 'Submission Kits', count: `${wizards.length}`,
          members: wizards.map((w: any) => {
            const total = (w.steps ?? []).length, done = progress.get(w.key) ?? 0;
            return { label: w.title ?? w.platform ?? w.key, sub: total ? `${done}/${total} steps` : 'not started', onClick: () => goWorkshop('listings') };
          }),
        },
        {
          key: 'metrics', label: 'Metrics', count: `${latestMetric.size}`,
          members: [...latestMetric.values()].map((m: any) => ({
            label: m.metric.replace(/_/g, ' '), sub: `${Number(m.value).toLocaleString()} · ${String(m.captured_at).slice(0, 10)}`,
            onClick: () => { localStorage.setItem('ledger_tab', 'metrics'); setRoom('ledger'); },
          })),
        },
      ]);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedRing = useMemo(() => rings?.find((r) => r.key === sel) ?? null, [rings, sel]);

  return (
    <div className="stack">
      <div className="brainrings">
        <svg className="ring-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {(rings ?? []).map((_, i) => { const p = pos(i); return <line key={i} x1="50" y1="50" x2={p.x} y2={p.y} />; })}
        </svg>
        <button className="ring-center" onClick={() => setSel(null)}>Lucius P.<br />Thundercat</button>
        {(rings ?? []).map((r, i) => {
          const p = pos(i);
          return (
            <button key={r.key} className={`ring-hub ${sel === r.key ? 'active' : ''}`} style={{ left: `${p.x}%`, top: `${p.y}%` }}
              onClick={() => setSel(sel === r.key ? null : r.key)}>
              <span className="ring-hub-label">{r.label}</span>
              <span className="ring-hub-count">{r.count}</span>
            </button>
          );
        })}
        {!rings && <div className="ring-center-loading muted small">unfolding…</div>}
      </div>

      {selectedRing ? (
        <div className="ring-panel">
          <div className="row-head"><strong>{selectedRing.label}</strong> <span className="muted small">{selectedRing.count} · click to open</span></div>
          <div className="ring-members">
            {selectedRing.members.length === 0 ? <span className="muted small">Nothing here yet.</span> : selectedRing.members.map((m, i) => (
              <div className="ring-chip" key={i}>
                <button className="ring-chip-main" onClick={m.onClick}><span className="ring-chip-label">{m.label}</span>{m.sub && <span className="ring-chip-sub muted">{m.sub}</span>}</button>
                {m.href && <a className="ring-chip-link" href={m.href} target="_blank" rel="noopener" title="open ↗">↗</a>}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted small" style={{ textAlign: 'center' }}>Six rings around the artist — tap one to unfold it and jump to the detail.</p>
      )}
    </div>
  );
}
