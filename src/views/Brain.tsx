import { lazy, Suspense } from 'react';
import { useSilk } from '../SilkContext';

const BrainGraph = lazy(() => import('../components/BrainGraph'));

export default function Brain() {
  const { focusNode, setFocusNode, pointedNode } = useSilk();

  // Top level — two bubbles.
  if (!focusNode) {
    return (
      <div className="stack">
        <div className="eyebrow">The Brain</div>
        <p className="muted">Silk's mind, made visible. The campaign, and its infrastructure.</p>
        <div className="brainmini" style={{ height: 240 }}>
          <button className={`node lpt ${pointedNode === 'lpt' ? 'pulse-point' : ''}`} style={{ left: '16%', top: '26%', width: 128, height: 128 }} onClick={() => setFocusNode('lpt')}>Lucius P.<br />Thundercat</button>
          <button className={`node svr ${pointedNode === 'svr' ? 'pulse-point' : ''}`} style={{ left: '58%', top: '44%', width: 84, height: 84 }} onClick={() => setFocusNode('svr')}>Silk Velvet<br />Records</button>
          <div className="node" style={{ left: '82%', top: '18%', width: 46, height: 46, borderStyle: 'dashed', color: 'var(--muted)', opacity: 0.4 }} title="reserved">+</div>
        </div>
        <p className="muted small">Tap Lucius P. Thundercat to unfold the six rings.</p>
      </div>
    );
  }

  if (focusNode === 'svr') {
    return (
      <div className="stack">
        <button className="btn sm ghost" onClick={() => setFocusNode(null)}>← Brain</button>
        <h2 style={{ marginTop: 0 }}>Silk Velvet Records</h2>
        <p className="muted small">Passive infrastructure — it exists so the artist + releases can point at it.</p>
        {[['Identity', 'Independent Canadian record label · styling "Silk Velvet Records"'], ['Roster', 'Lucius P. Thundercat (room for more)'], ['Metadata', 'Label field: TODO across releases · MusicBrainz/Wikidata label item: not created'], ['Discography-as-label', 'Releases with the label field properly set: TODO(Mat)'], ['Provenance', 'Facts sourced from the entity master']].map(([h, b]) => (
          <div className="card" key={h}><h2 style={{ marginTop: 0 }}>{h}</h2><p>{b}</p></div>
        ))}
      </div>
    );
  }

  // Any LPT node → the graph (concentric rings).
  return <Suspense fallback={<p className="muted">Unfolding the rings…</p>}><BrainGraph /></Suspense>;
}
