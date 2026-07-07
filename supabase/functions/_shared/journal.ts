// Layer 4 retrieval (Brief Seven) — shared so both the journal_retrieve Edge
// Function and the in-process system_prompt_builder use one implementation.
// Returns: top-N semantic matches + recent-N + permanent (exemplar/onboarding).
import { admin } from './auth.ts';
import { embed } from './embed.ts';

export interface JournalEntry { id: string; entry: string; tags: string[]; created_at: string; similarity?: number; score?: number; source: string }

// Source weight: current-session truth ≫ canonical corrections ≫ ordinary journal.
function sourceWeight(tags: string[] = []): number {
  if (tags.includes('exemplar') || tags.includes('onboarding')) return 1.35;
  if (tags.includes('correction') || tags.includes('cascade') || tags.includes('reconciliation')) return 1.18;
  if (tags.includes('tool-use') || tags.includes('bookkeeping')) return 0.8;
  return 1.0;
}

export async function retrieve(query: string, topN = 6, recentN = 5): Promise<{ relevant: JournalEntry[]; recent: JournalEntry[]; permanent: JournalEntry[] }> {
  let relevant: JournalEntry[] = [];
  const qv = await embed(query);
  if (qv) {
    // Hybrid score = semantic similarity × recency decay × source weight. Pull a wider
    // candidate set, re-rank, then take topN — recency and source matter, not similarity alone.
    const { data } = await admin.rpc('match_journal', { query_embedding: qv, match_count: topN * 3 });
    const now = Date.now();
    relevant = (data ?? []).map((r: any) => {
      const ageDays = (now - Date.parse(r.created_at)) / 864e5;
      const recency = 0.4 + 0.6 * Math.exp(-ageDays / 30); // ~30-day soft decay, never below 0.4
      const score = (r.similarity ?? 0) * recency * sourceWeight(r.tags);
      return { ...r, source: 'relevant', score };
    }).sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0)).slice(0, topN);
  }
  const { data: recentRows } = await admin.from('silk_journal')
    .select('id, entry, tags, created_at').order('created_at', { ascending: false }).limit(recentN);
  const recent: JournalEntry[] = (recentRows ?? []).map((r) => ({ ...r, source: 'recent' }));

  const { data: permRows } = await admin.from('silk_journal')
    .select('id, entry, tags, created_at').overlaps('tags', ['exemplar', 'onboarding']).order('created_at', { ascending: false }).limit(8);
  const permanent: JournalEntry[] = (permRows ?? []).map((r) => ({ ...r, source: 'permanent' }));

  return { relevant, recent, permanent };
}
