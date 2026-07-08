// The single guarded entry point for filing an action_queue item. Every queue-writing
// path routes through here so the guarantees hold system-wide, not per-function:
//   1. DEDUPE — never create a second PENDING (proposed/approved) item with the same
//      kind + title; refresh the existing row in place instead.
//   2. ROLLING 24h CAP — optional per-kind ceiling so a broken/repeating check
//      (e.g. a degenerate audit) can't flood the queue even if dedupe has an edge case.
import { admin } from './auth.ts';

export interface FileOpts {
  kind: string;
  payload: Record<string, unknown> & { title?: string };
  risk_tier?: string;
  maxPerDay?: number; // rolling-24h cap per kind; 0/undefined = uncapped
}

export async function fileQueueItem(o: FileOpts): Promise<{ filed: boolean; id?: string; reason?: string }> {
  const title = String(o.payload?.title ?? '').trim();

  // 1) dedupe against an existing pending item (same kind + title)
  if (title) {
    const { data: dup } = await admin.from('action_queue')
      .select('id, payload').eq('kind', o.kind).in('status', ['proposed', 'approved'])
      .eq('payload->>title', title).limit(1).maybeSingle();
    if (dup) {
      await admin.from('action_queue')
        .update({ payload: { ...(dup.payload as Record<string, unknown>), ...o.payload, refreshed_at: new Date().toISOString() } })
        .eq('id', dup.id);
      return { filed: false, id: dup.id as string, reason: 'deduped: pending item with same kind+title exists' };
    }
  }

  // 2) rolling 24h per-kind cap
  if (o.maxPerDay && o.maxPerDay > 0) {
    const since = new Date(Date.now() - 864e5).toISOString();
    const { count } = await admin.from('action_queue')
      .select('id', { count: 'exact', head: true }).eq('kind', o.kind).gte('created_at', since);
    if ((count ?? 0) >= o.maxPerDay) return { filed: false, reason: `capped: ${o.kind} filed ${count}x in last 24h (max ${o.maxPerDay})` };
  }

  // 3) insert
  const { data, error } = await admin.from('action_queue')
    .insert({ kind: o.kind, status: 'proposed', risk_tier: o.risk_tier ?? 'amber', payload: o.payload })
    .select('id').single();
  if (error) return { filed: false, reason: error.message };
  return { filed: true, id: data.id as string };
}
