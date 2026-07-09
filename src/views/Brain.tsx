import { useSilk } from '../SilkContext';
import BrainRings from '../components/BrainRings';
import BrainQueue from '../components/BrainQueue';

export default function Brain() {
  const { focusNode, setFocusNode, pointedNode } = useSilk();

  // Top level — two bubbles.
  if (!focusNode) {
    return (
      <div className="stack">
        <BrainQueue />
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
        {[['Identity', 'Independent Canadian record label · styling "Silk Velvet Records"'], ['Roster', 'Lucius P. Thundercat (room for more)'], ['Metadata', 'Label field across releases · MusicBrainz/Wikidata label item'], ['Provenance', 'Facts sourced from the entity master']].map(([h, b]) => (
          <div className="card" key={h}><h2 style={{ marginTop: 0 }}>{h}</h2><p>{b}</p></div>
        ))}
      </div>
    );
  }

  // LPT (or any collaborator/platform node Silk pointed at) → the six-ring navigable map.
  return (
    <div className="stack">
      <button className="btn sm ghost" onClick={() => setFocusNode(null)}>← Brain</button>
      <h2 style={{ margin: '0.2rem 0 0' }}>The six rings</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Lucius P. Thundercat at the centre — collaborators, releases, platforms, corpus pages, submission kits, and metrics radiating out. Every node jumps to its detail.</p>
      <BrainRings />
    </div>
  );
}
