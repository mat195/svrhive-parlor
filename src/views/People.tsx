import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';
import { buildDirectory, sortDirectory, type Collaborator, type ReleaseLite, type SortKey } from '../lib/collab';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const money = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}K` : String(n));
const LOCAL_LABEL: Record<string, string> = { yes: 'Montréal', no: 'out-of-town', unknown: 'locality unknown' };

type Filt = 'all' | 'local' | 'notable';
const SORTS: { id: SortKey; label: string }[] = [
  { id: 'tracks', label: 'Track count' }, { id: 'streams', label: 'Streams' },
  { id: 'recent', label: 'Most recent' }, { id: 'alpha', label: 'A–Z' },
];

export default function People() {
  const { focusNode, setFocusNode } = useSilk();
  const [list, setList] = useState<Collaborator[] | null>(null);
  const [sort, setSort] = useState<SortKey>('tracks');
  const [filt, setFilt] = useState<Filt>('all');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('releases')
        .select('id, title, catalog_number, release_date, tier, streams, label_credit, spotify_album_id');
      setList(buildDirectory((data as ReleaseLite[]) ?? []));
    })();
  }, []);

  // Deep-link from the Brain "Collaborators" ring (focusNode = collab-<slug>).
  useEffect(() => {
    if (focusNode?.startsWith('collab-') && list) {
      const want = focusNode.slice(7);
      const hit = list.find((c) => slug(c.name) === want);
      if (hit) { setOpen(hit.name); setFilt('all'); }
      setFocusNode(null);
    }
  }, [focusNode, list, setFocusNode]);

  const shown = useMemo(() => {
    if (!list) return [];
    let l = list;
    if (filt === 'local') l = l.filter((c) => c.local === 'yes');
    else if (filt === 'notable') l = l.filter((c) => c.notable);
    return sortDirectory(l, sort);
  }, [list, sort, filt]);

  if (!list) return <p className="muted">Loading collaborators…</p>;

  return (
    <div className="stack">
      <div className="eyebrow">The people Lucius P. Thundercat has actually recorded with</div>
      <h2 style={{ margin: '0 0 0.1rem' }}>Collaborator Directory</h2>
      <p className="muted small" style={{ marginTop: 0 }}>{list.length} collaborators, derived from Spotify release credits. Click one to see every shared release.</p>

      <div className="subtabs">
        <span className="muted small" style={{ alignSelf: 'center' }}>sort:</span>
        {SORTS.map((s) => <button key={s.id} className={sort === s.id ? 'chip active' : 'chip'} onClick={() => setSort(s.id)}>{s.label}</button>)}
      </div>
      <div className="subtabs">
        <span className="muted small" style={{ alignSelf: 'center' }}>show:</span>
        <button className={filt === 'all' ? 'chip active' : 'chip'} onClick={() => setFilt('all')}>All ({list.length})</button>
        <button className={filt === 'local' ? 'chip active' : 'chip'} onClick={() => setFilt('local')}>Montréal-local ({list.filter((c) => c.local === 'yes').length})</button>
        <button className={filt === 'notable' ? 'chip active' : 'chip'} onClick={() => setFilt('notable')}>Name-recognition ({list.filter((c) => c.notable).length})</button>
      </div>

      <div className="collab-dir">
        {shown.map((c) => {
          const isOpen = open === c.name;
          const tiers = Object.keys(c.tierDist).map(Number).sort();
          return (
            <div className={`collab-row ${isOpen ? 'open' : ''}`} key={c.name}>
              <button className="collab-head" onClick={() => setOpen(isOpen ? null : c.name)} aria-expanded={isOpen}>
                <span className="collab-name">{c.name}{c.notable && <span className="collab-star" title="name-recognition feature"> ★</span>}</span>
                <span className={`collab-loc loc-${c.local}`}>{LOCAL_LABEL[c.local]}</span>
                <span className="collab-stat"><strong>{c.trackCount}</strong> track{c.trackCount !== 1 ? 's' : ''}</span>
                <span className="collab-stat"><strong>{money(c.combinedStreams)}</strong> streams</span>
                <span className="collab-role muted small">{c.role}</span>
                <span className="chev">{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen && (
                <div className="collab-detail">
                  <div className="collab-meta muted small">
                    <span>Verified by: {c.verifiedBy}</span>
                    {tiers.length > 0 && <span> · Tiers: {tiers.map((t) => `T${t}×${c.tierDist[t]}`).join(', ')}</span>}
                    {c.mostRecent && <span> · Latest: {c.mostRecent.slice(0, 4)}</span>}
                  </div>
                  <table className="collab-releases">
                    <thead><tr><th>Release</th><th>Cat #</th><th>Year</th><th>Tier</th><th>Streams</th><th></th></tr></thead>
                    <tbody>
                      {c.releases.map((r) => (
                        <tr key={r.id}>
                          <td>{r.title}</td>
                          <td className="mono">{r.catalog ?? '—'}</td>
                          <td>{r.year ?? '—'}</td>
                          <td>{r.tier != null ? `T${r.tier}` : '—'}</td>
                          <td className="num">{r.streams.toLocaleString()}</td>
                          <td>{r.albumId && <a className="link small" href={`https://open.spotify.com/album/${r.albumId}`} target="_blank" rel="noopener">Spotify ↗</a>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
