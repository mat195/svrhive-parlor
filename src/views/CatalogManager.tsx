import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Rel {
  id: string; title: string; release_date: string | null; tier: number | null;
  streams: number | null; catalog_number: string | null; label_credit: string | null;
  spotify_album_id: string | null; cover_art: { source_url: string | null }[] | null; tracks: { isrc: string | null }[] | null;
}
type Row = { id: string; cat: string; title: string; year: string; tier: number | null; streams: number; isrc: string; feat: string; cover: string | null; albumId: string | null };
type Col = 'cat' | 'title' | 'year' | 'tier' | 'streams';

const catNum = (s: string) => { const m = /(\d+)/.exec(s || ''); return m ? Number(m[1]) : 1e9; };

export default function CatalogManager() {
  const [rels, setRels] = useState<Rel[] | null>(null);
  const [sort, setSort] = useState<{ col: Col; dir: 1 | -1 }>({ col: 'cat', dir: 1 });
  const [tier, setTier] = useState<number | 'all'>('all');

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('releases')
        .select('id, title, release_date, tier, streams, catalog_number, label_credit, spotify_album_id, cover_art(source_url), tracks(isrc)');
      setRels((data as Rel[]) ?? []);
    })();
  }, []);

  const rows: Row[] = useMemo(() => (rels ?? []).map((r) => ({
    id: r.id,
    cat: r.catalog_number ?? '—',
    title: r.title,
    year: r.release_date ? r.release_date.slice(0, 4) : '—',
    tier: r.tier,
    streams: Number(r.streams ?? 0),
    isrc: r.tracks?.find((t) => t.isrc)?.isrc ?? '—',
    feat: (r.label_credit ?? '').replace(/^feat\.?\s*/i, ''),
    cover: r.cover_art?.[0]?.source_url ?? null,
    albumId: r.spotify_album_id,
  })), [rels]);

  const shown = useMemo(() => {
    let l = tier === 'all' ? rows : rows.filter((r) => r.tier === tier);
    const { col, dir } = sort;
    l = [...l].sort((a, b) => {
      let d = 0;
      if (col === 'cat') d = catNum(a.cat) - catNum(b.cat);
      else if (col === 'title') d = a.title.localeCompare(b.title);
      else if (col === 'year') d = a.year.localeCompare(b.year);
      else if (col === 'tier') d = (a.tier ?? 9) - (b.tier ?? 9);
      else d = a.streams - b.streams;
      return d * dir;
    });
    return l;
  }, [rows, sort, tier]);

  if (!rels) return <p className="muted">Loading catalog…</p>;

  const th = (col: Col, label: string, cls = '') => (
    <th className={`sortable ${cls}`} onClick={() => setSort((s) => ({ col, dir: s.col === col && s.dir === 1 ? -1 : 1 }))}>
      {label}{sort.col === col ? <span className="sort-arrow">{sort.dir === 1 ? ' ↑' : ' ↓'}</span> : ''}
    </th>
  );
  const tierCounts = [1, 2, 3, 4].map((t) => rows.filter((r) => r.tier === t).length);

  return (
    <div className="stack">
      <p className="muted small" style={{ margin: '0 0 0.2rem' }}>
        {rows.length} releases — the reference view of what's actually in the catalog. Click any column to sort.
      </p>
      <div className="subtabs">
        <span className="muted small" style={{ alignSelf: 'center' }}>tier:</span>
        <button className={tier === 'all' ? 'chip active' : 'chip'} onClick={() => setTier('all')}>All ({rows.length})</button>
        {[1, 2, 3, 4].map((t) => <button key={t} className={tier === t ? 'chip active' : 'chip'} onClick={() => setTier(t)}>T{t} ({tierCounts[t - 1]})</button>)}
      </div>

      <div className="catalog-wrap">
        <table className="catalog-table">
          <thead>
            <tr>
              <th></th>
              {th('cat', 'Cat #')}
              {th('title', 'Title')}
              {th('year', 'Year')}
              {th('tier', 'Tier')}
              {th('streams', 'Streams', 'num')}
              <th>ISRC</th>
              <th>Featured</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                <td className="cover-cell">
                  {r.cover
                    ? <img src={r.cover} alt="" width={38} height={38} loading="lazy" />
                    : <span className="cover-ph" title="no cover art">♪</span>}
                </td>
                <td className="mono">{r.cat}</td>
                <td>{r.albumId ? <a className="link" href={`https://open.spotify.com/album/${r.albumId}`} target="_blank" rel="noopener">{r.title}</a> : r.title}</td>
                <td>{r.year}</td>
                <td>{r.tier != null ? <span className={`tier-pill t${r.tier}`}>T{r.tier}</span> : '—'}</td>
                <td className="num">{r.streams.toLocaleString()}</td>
                <td className="mono tiny">{r.isrc}</td>
                <td className="muted small">{r.feat || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
