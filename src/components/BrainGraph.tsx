import { useEffect, useRef, useState } from 'react';
import cytoscape from 'cytoscape';
import { supabase } from '../lib/supabase';
import { useSilk } from '../SilkContext';
import { buildElements, CONF_COLOR, type LiveData } from '../lib/brainGraph';

type Lens = 'truth' | 'visibility' | 'coverage' | 'corroboration';
const LENSES: Lens[] = ['truth', 'visibility', 'coverage', 'corroboration'];

function sizeOpacity(d: any, lens: Lens): [number, number] {
  const ring = d.ring ?? 3;
  if (lens === 'visibility') { const v = d.vis || 0; return [v > 0 ? Math.min(74, 22 + v * 3) : 18, v > 0 || d.kind === 'center' ? 1 : 0.35]; }
  if (lens === 'coverage') { const c = d.cov || 0; return [c > 0 ? 46 : 22, c > 0 || d.kind === 'center' ? 1 : 0.35]; }
  if (lens === 'corroboration') { const c = d.corr || 0; return [Math.max(20, 18 + c * 9), c > 0 || d.kind === 'center' ? 1 : 0.4]; }
  return [d.kind === 'center' ? 72 : Math.max(24, 56 - ring * 5), 1]; // truth
}

export default function BrainGraph() {
  const boxRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const { focusNode, setFocusNode, pointedNode, askSilk } = useSilk();
  const [lens, setLens] = useState<Lens>('truth');
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null);
  const [nodeList, setNodeList] = useState<{ id: string; label: string; confidence: string }[]>([]);

  useEffect(() => {
    let cy: cytoscape.Core;
    (async () => {
      const [{ data: runs }, { data: pos }, { data: pub }] = await Promise.all([
        supabase.from('visibility_runs').select('mentions_total, summary').order('run_at', { ascending: false }).limit(1),
        supabase.from('brain_positions').select('node_key, x, y'),
        supabase.from('corpus_drafts').select('target_query').eq('status', 'published'),
      ]);
      const summary = runs?.[0]?.summary ?? {};
      const covered = new Set<string>();
      (pub ?? []).forEach(() => { /* covered matching handled in builder via keys; kept simple */ });
      const live: LiveData = { artists: summary.artists ?? [], score: runs?.[0]?.mentions_total ?? 0, covered };
      const els = buildElements(live);
      els.forEach((e) => { if (e.data.ring !== undefined) { const [s, o] = sizeOpacity(e.data, 'truth'); e.data._size = s; e.data._opacity = o; } });
      setNodeList(els.filter((e) => e.data.ring !== undefined).map((e) => ({ id: e.data.id, label: e.data.label, confidence: e.data.confidence })));

      const saved = new Map((pos ?? []).map((p: any) => [p.node_key, { x: p.x, y: p.y }]));
      cy = cytoscape({
        container: boxRef.current!,
        elements: els as any,
        minZoom: 0.3, maxZoom: 2.5, wheelSensitivity: 0.2,
        style: [
          { selector: 'node', style: { 'background-color': (e: any) => CONF_COLOR[e.data('confidence')] || '#6b6058', label: 'data(label)', color: '#f5eee0', 'font-size': '9px', 'font-family': 'Inter, sans-serif', 'text-wrap': 'wrap', 'text-max-width': '84px', 'text-valign': 'bottom', 'text-margin-y': 4, width: (e: any) => e.data('_size'), height: (e: any) => e.data('_size'), 'border-width': 1, 'border-color': 'rgba(255,255,255,0.18)', 'text-outline-width': 2, 'text-outline-color': '#120812', opacity: (e: any) => e.data('_opacity') } },
          { selector: 'node[kind="center"]', style: { 'background-color': '#c9a961', 'border-color': '#c9a961', 'font-size': '12px', color: '#1a0f14', 'text-outline-color': '#c9a961', 'text-valign': 'center', 'text-margin-y': 0 } },
          { selector: 'node[?missing]', style: { 'border-style': 'dashed' } },
          { selector: 'node[confidence="superseded"]', style: { 'border-style': 'dashed' } },
          { selector: 'edge', style: { width: 1, 'line-color': 'rgba(201,169,97,0.10)', 'curve-style': 'straight' } },
          { selector: '.pointed', style: { 'border-width': 4, 'border-color': '#c9a961' } },
          { selector: ':selected', style: { 'border-width': 3, 'border-color': '#e8d9b8' } },
        ],
        layout: saved.size >= els.filter((e) => e.data.ring !== undefined).length
          ? { name: 'preset', positions: (n: any) => saved.get(n.id()) } as any
          : { name: 'concentric', concentric: (n: any) => 7 - (n.data('ring') ?? 3), levelWidth: () => 1, minNodeSpacing: 26, animate: true, animationDuration: 420, animationEasing: 'ease-out' } as any,
      });
      cyRef.current = cy;

      cy.on('tap', 'node', (e) => { const n = e.target; setFocusNode(n.id()); askSilk(`Tell me about ${n.data('label')}${n.data('note') ? ' — ' + n.data('note') : ''}.`); });
      cy.on('mouseover', 'node', (e) => { const n = e.target; const p = e.renderedPosition; setTip({ x: p.x, y: p.y, text: `${n.data('label')} · ${n.data('confidence')}${n.data('note') ? ' · ' + n.data('note') : ''}` }); });
      cy.on('mouseout', 'node', () => setTip(null));
      cy.on('dragfree', 'node', async (e) => { const n = e.target; const { x, y } = n.position(); await supabase.from('brain_positions').upsert({ node_key: n.id(), x, y, updated_at: new Date().toISOString() }, { onConflict: 'node_key' }); });
    })();
    return () => { cy?.destroy(); cyRef.current = null; };
  }, []);

  // Lens re-weighting.
  useEffect(() => {
    const cy = cyRef.current; if (!cy) return;
    cy.batch(() => cy.nodes().forEach((n) => { const [s, o] = sizeOpacity(n.data(), lens); n.data('_size', s); n.data('_opacity', o); }));
  }, [lens]);

  // Silk points / deep-link focus → flash + center.
  useEffect(() => {
    const cy = cyRef.current; if (!cy) return; const key = pointedNode || focusNode; if (!key) return;
    const n = cy.$id(key); if (n.empty()) return;
    cy.nodes().removeClass('pointed'); n.addClass('pointed');
    cy.animate({ center: { eles: n }, zoom: 1.1 }, { duration: 400, easing: 'ease-out' });
    const t = setTimeout(() => n.removeClass('pointed'), 6000);
    return () => clearTimeout(t);
  }, [pointedNode, focusNode]);

  return (
    <div className="braingraph-wrap">
      <div className="row-head" style={{ marginBottom: '0.6rem' }}>
        <button className="btn sm ghost" onClick={() => setFocusNode(null)}>← Brain</button>
        <div className="subtabs" style={{ margin: 0 }}>{LENSES.map((l) => <button key={l} className={lens === l ? 'chip active' : 'chip'} onClick={() => setLens(l)}>{l}</button>)}</div>
      </div>
      <div className="braingraph" ref={boxRef} role="application" aria-label="Brain graph" />
      {tip && <div className="graph-tip" style={{ left: tip.x + 12, top: tip.y + 60 }}>{tip.text}</div>}
      <p className="muted small" style={{ marginTop: '0.5rem' }}>Drag nodes to arrange your room · pinch/scroll to zoom · tap a node to ask Silk. Confidence: <span className="cdot c-verified" />verified <span className="cdot c-unverified" />unverified <span className="cdot c-quarantined" />missing/unconfirmed.</p>
      {/* Accessible node list (keyboard + screen reader) */}
      <ul className="sr-nodelist">
        {nodeList.map((n) => <li key={n.id}><button onClick={() => setFocusNode(n.id)}>{n.label} ({n.confidence})</button></li>)}
      </ul>
    </div>
  );
}
