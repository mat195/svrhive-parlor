import * as D from './brainData';

export interface LiveData {
  artists: { name: string; count: number }[]; // competitor mention counts (proxy for visibility)
  score: number;
  covered: Set<string>;      // node keys with a live corpus page
}

export interface Elem { data: Record<string, any>; }

function visFor(label: string, artists: { name: string; count: number }[]): number {
  const l = label.toLowerCase();
  const hit = artists.find((a) => l.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(l));
  return hit ? hit.count : 0;
}

/** Build cytoscape elements: LPT center + 6 concentric rings + faint web edges. */
export function buildElements(live: LiveData): Elem[] {
  const nodes: Elem[] = [];
  const edges: Elem[] = [];
  const add = (id: string, label: string, ring: number, extra: Record<string, any> = {}) => {
    nodes.push({ data: { id, label, ring, ...extra } });
    if (id !== 'lpt') edges.push({ data: { id: `e-${id}`, source: 'lpt', target: id } });
  };

  add('lpt', 'Lucius P. Thundercat', 0, { confidence: 'verified', kind: 'center', vis: live.score, corr: 11, cov: live.covered.has('lpt') ? 1 : 0 });
  add('svr', 'Silk Velvet Records', 1, { confidence: 'verified', kind: 'label', vis: 0, corr: 1, cov: 0 });

  D.identity.forEach((n) => add(n.key, n.label.length > 34 ? n.label.slice(0, 32) + '…' : n.label, 1, { confidence: n.confidence, kind: 'identity', note: n.note, vis: 0, corr: n.confidence === 'verified' ? 1 : 0, cov: 0 }));
  D.catalog.forEach((n) => add(n.key, n.label.split(' (')[0], 2, { confidence: n.confidence, kind: 'release', note: n.label, vis: visFor(n.label, live.artists), corr: 1, cov: live.covered.has(n.key) ? 1 : 0 }));
  D.collaborators.forEach((n) => add(n.key, n.label, 3, { confidence: n.confidence, kind: 'collab', note: n.note, vis: visFor(n.label, live.artists), corr: n.confidence === 'verified' ? 1 : 0, cov: live.covered.has(n.key) ? 1 : 0 }));
  D.platforms.forEach((n) => add(n.key, n.label, 4, { confidence: n.confidence, kind: 'platform', note: n.note, missing: !!n.missing, url: n.url, vis: 0, corr: n.url ? 2 : 0, cov: 0 }));
  add('disc-probes', 'similarity probes (instrument)', 5, { confidence: 'unverified', kind: 'discovery', note: 'reference artists live in prompts.json, not identity', vis: 0, corr: 0, cov: 0 });
  add('disc-corpus', 'corpus pages', 5, { confidence: 'unverified', kind: 'discovery', vis: 0, corr: 0, cov: live.covered.size });
  add('disc-airef', 'AI referrals', 5, { confidence: 'unverified', kind: 'discovery', vis: 0, corr: 0, cov: 0 });
  [['tl-corrected', 'identity corrected'], ['tl-site', 'site live'], ['tl-bio', 'bio published'], ['tl-firstai', 'first AI visit (pending)']]
    .forEach(([id, label]) => add(id, label, 6, { confidence: 'verified', kind: 'timeline', vis: 0, corr: 0, cov: 0 }));

  return [...nodes, ...edges];
}

export const CONF_COLOR: Record<string, string> = {
  verified: '#8a9b6a', unverified: '#c9a961', quarantined: '#6b6058', superseded: '#3a2f34',
};
