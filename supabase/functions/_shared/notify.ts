// Proactive push: Silk tells Mat something happened without being asked. Writes a row the
// floating chat widget surfaces as an unread badge + list. Use this ONLY for things Mat would
// want to know even while away or on another page — a finished battery, a blocked gate, a
// resolved stall, the morning briefing. NOT routine tool calls. De-dupes against an identical
// unread notification of the same kind in the last `dedupeMins` so repeated cron passes don't
// stack the same alert.
import { admin } from './auth.ts';

export interface NotifyInput {
  kind: 'briefing' | 'battery' | 'gate-blocked' | 'stall' | 'job-done' | 'answer';
  title: string;
  body?: string;
  url?: string;
  priority?: 'normal' | 'high';
  dedupeMins?: number; // suppress if an unread same-kind+title exists within this window (default 180)
}

export async function notify(n: NotifyInput): Promise<{ pushed: boolean; id?: string; reason?: string }> {
  const dedupeMins = n.dedupeMins ?? 180;
  const since = new Date(Date.now() - dedupeMins * 60_000).toISOString();
  const { data: dupe } = await admin.from('silk_notifications')
    .select('id').eq('kind', n.kind).eq('title', n.title).is('read_at', null)
    .gte('created_at', since).limit(1).maybeSingle();
  if (dupe) return { pushed: false, reason: 'deduped' };

  const { data, error } = await admin.from('silk_notifications')
    .insert({ kind: n.kind, title: n.title, body: n.body ?? null, url: n.url ?? null, priority: n.priority ?? 'normal' })
    .select('id').single();
  if (error) return { pushed: false, reason: error.message };
  return { pushed: true, id: data!.id as string };
}
