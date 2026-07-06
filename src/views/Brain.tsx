import { useEffect, useState } from 'react';
import { useSilk } from '../SilkContext';
import { supabase } from '../lib/supabase';
import * as D from '../lib/brainData';

type Lens = 'truth' | 'visibility' | 'coverage' | 'corroboration';
const LENSES: Lens[] = ['truth', 'visibility', 'coverage', 'corroboration'];

function Dot({ c }: { c: D.Confidence }) {
  return <span className={`cdot c-${c}`} title={c} />;
}

function NodeRow({ n, lens, covered, pointed, onPick }: { n: D.Node; lens: Lens; covered: boolean; pointed: string | null; onPick: (n: D.Node) => void }) {
  const emphasize =
    lens === 'coverage' ? covered :
    lens === 'corroboration' ? !!n.url :
    lens === 'visibility' ? n.confidence === 'verified' : true;
  return (
    <li className={`row ${pointed === n.key ? 'pulse-point' : ''}`} style={{ opacity: emphasize ? 1 : 0.4 }}>
      <button className="node-row" onClick={() => onPick(n)} style={{ background: 'none', border: 'none', color: 'inherit', textAlign: 'left', cursor: 'pointer', width: '100%' }}>
        <Dot c={n.missing ? 'quarantined' : n.confidence} />
        <span style={{ textDecoration: n.confidence === 'superseded' ? 'line-through' : 'none' }}>{n.label}</span>
        {n.missing && <span className="chip" style={{ marginLeft: 8 }}>+ add</span>}
        {n.note && <span className="muted small"> · {n.note}</span>}
      </button>
    </li>
  );
}

export default function Brain() {
  const { focusNode, setFocusNode, pointedNode, askSilk } = useSilk();
  const [lens, setLens] = useState<Lens>('truth');
  const [openRing, setOpenRing] = useState<string>('identity');
  const [covered, setCovered] = useState<Set<string>>(new Set());

  // Coverage lens: which nodes have a live corpus page (rough match on target query).
  useEffect(() => {
    supabase.from('corpus_drafts').select('target_query,status').eq('status', 'published').then(({ data }) => {
      const s = new Set<string>();
      (data ?? []).forEach((d) => { const q = (d.target_query || '').toLowerCase(); D.collaborators.concat(D.catalog).forEach((n) => { if (q.includes(n.label.toLowerCase().split(' ')[0])) s.add(n.key); }); });
      setCovered(s);
    });
  }, []);

  // Deep-link / navigation: a focused collab/platform/rel opens the relevant ring.
  useEffect(() => {
    if (!focusNode) return;
    if (focusNode.startsWith('collab-')) setOpenRing('collaborators');
    else if (focusNode.startsWith('platform-')) setOpenRing('platforms');
    else if (focusNode.startsWith('rel-')) setOpenRing('catalog');
    else if (focusNode.startsWith('identity-')) setOpenRing('identity');
  }, [focusNode]);

  const atTop = !focusNode || (focusNode !== 'svr' && focusNode !== 'lpt' && !focusNode.startsWith('collab-') && !focusNode.startsWith('platform-') && !focusNode.startsWith('rel-') && !focusNode.startsWith('identity-') && focusNode !== 'lpt-open');

  const pick = (n: D.Node) => { setFocusNode(n.key); askSilk(n.note ? `${n.label} — ${n.note}. Tell me more.` : `Tell me about ${n.label}.`); };

  // TOP: two bubbles
  if (!focusNode || (focusNode !== 'svr' && !focusNode.startsWith('lpt') && atTop && focusNode === null)) {
    return (
      <div className="stack">
        <div className="eyebrow">The Brain</div>
        <p className="muted">Silk's mind, made visible. Two bubbles — the campaign, and its infrastructure.</p>
        <div className="brainmini" style={{ height: 220 }}>
          <button className={`node lpt ${pointedNode === 'lpt' ? 'pulse-point' : ''}`} style={{ left: '18%', top: '28%', width: 120, height: 120 }} onClick={() => setFocusNode('lpt')}>Lucius P.<br />Thundercat</button>
          <button className={`node svr ${pointedNode === 'svr' ? 'pulse-point' : ''}`} style={{ left: '58%', top: '42%', width: 82, height: 82 }} onClick={() => setFocusNode('svr')}>Silk Velvet<br />Records</button>
          <div className="node" style={{ left: '80%', top: '20%', width: 46, height: 46, borderStyle: 'dashed', color: 'var(--muted)', opacity: 0.4 }} title="reserved">+</div>
        </div>
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

  // LPT view — six rings
  const ringNodes: Record<string, D.Node[]> = {
    identity: D.identity, catalog: D.catalog, collaborators: D.collaborators, platforms: D.platforms,
  };

  return (
    <div className="stack">
      <div className="row-head">
        <button className="btn sm ghost" onClick={() => setFocusNode(null)}>← Brain</button>
        <div className="subtabs" style={{ margin: 0 }}>
          {LENSES.map((l) => <button key={l} className={lens === l ? 'chip active' : 'chip'} onClick={() => setLens(l)}>{l}</button>)}
        </div>
      </div>
      <h2 style={{ marginTop: 0 }}><span className="cdot c-verified" /> Lucius P. Thundercat</h2>

      {D.RINGS.map((ring) => {
        const nodes = ringNodes[ring.key];
        const open = openRing === ring.key;
        return (
          <div className="card" key={ring.key}>
            <button className="row-head" style={{ width: '100%', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }} onClick={() => setOpenRing(open ? '' : ring.key)}>
              <h2 style={{ margin: 0 }}>Ring · {ring.label}</h2>
              <span className="muted">{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              ring.key === 'discovery' ? (
                <div className="small">
                  <p className="muted">Reference rappers: {D.referenceRappers.join(' · ')}</p>
                  <p className="muted">Competitor artists, cited domains and AI-referral glow live in the Ledger + Watchtower. Corpus pages targeting LPT surface here once published.</p>
                </div>
              ) : ring.key === 'timeline' ? (
                <div className="small muted">Release + submission + first-AI-visit river — full scrubber lands in the graph view. First AI visit becomes a permanent star.</div>
              ) : (
                <ul className="rows" style={{ marginTop: '0.6rem' }}>
                  {nodes.map((n) => <NodeRow key={n.key} n={n} lens={lens} covered={covered.has(n.key)} pointed={pointedNode} onPick={pick} />)}
                </ul>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
