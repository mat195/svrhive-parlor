// Layer 4 retrieval (Brief Seven) — shared so both the journal_retrieve Edge
// Function and the in-process system_prompt_builder use one implementation.
// Returns: top-N semantic matches + recent-N + permanent (exemplar/onboarding).
import { admin } from './auth.ts';
import { embed } from './embed.ts';

export interface JournalEntry { id: string; entry: string; tags: string[]; created_at: string; similarity?: number; source: string }

export async function retrieve(query: string, topN = 6, recentN = 5): Promise<{ relevant: JournalEntry[]; recent: JournalEntry[]; permanent: JournalEntry[] }> {
  const relevant: JournalEntry[] = [];
  const qv = await embed(query);
  if (qv) {
    const { data } = await admin.rpc('match_journal', { query_embedding: qv, match_count: topN });
    for (const r of data ?? []) relevant.push({ ...r, source: 'relevant' });
  }
  const { data: recentRows } = await admin.from('silk_journal')
    .select('id, entry, tags, created_at').order('created_at', { ascending: false }).limit(recentN);
  const recent: JournalEntry[] = (recentRows ?? []).map((r) => ({ ...r, source: 'recent' }));

  const { data: permRows } = await admin.from('silk_journal')
    .select('id, entry, tags, created_at').overlaps('tags', ['exemplar', 'onboarding']).order('created_at', { ascending: false }).limit(8);
  const permanent: JournalEntry[] = (permRows ?? []).map((r) => ({ ...r, source: 'permanent' }));

  return { relevant, recent, permanent };
}
