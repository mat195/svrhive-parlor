// Risk classification for queue items (Brief: one-tap approvals for zero-risk work).
// Silk assesses the tier at filing time. Uncertainty defaults UP (safer), never down.
export type RiskTier = 'green' | 'amber' | 'red' | 'grey';

const GREEN = new Set(['audit-initiative', 'catalog-audit', 'catalog-audit-supplemental', 'workspace-edit', 'tag', 'observation', 'cache-refresh', 'read-audit']);
const AMBER = new Set(['corpus-initiative', 'corpus-page', 'answer-cascade', 'weekly-consolidation', 'appears-on-audit', 'catalog-backfill', 'doctrine-sync', 'bio-approval', 'entity-submission', 'revise-role', 'metadata-fix', 'reference-swap', 'genre-change', 'bio-revision', 'tier-reclass']);
const RED = new Set(['corpus-publish', 'corpus-retract', 'submission-final', 'site-deploy', 'site-commit']);
const GREY = new Set(['strategic-question', 'clarification', 'blocked', 'question']);

export function riskTier(kind: string, payload?: Record<string, unknown>): RiskTier {
  if (GREY.has(kind) || payload?.grey === true) return 'grey';
  if (RED.has(kind) || payload?.publishes === true) return 'red';
  if (GREEN.has(kind)) return 'green';
  if (AMBER.has(kind)) return 'amber';
  // Uncertainty defaults up (amber), never down.
  return 'amber';
}
