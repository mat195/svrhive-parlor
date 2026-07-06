// Silk status writer — every long-running action writes on start / step / done.
import { admin } from './auth.ts';

export async function startStatus(state: string, label: string, source: string, sublabel: string | null = null): Promise<string | null> {
  const { data } = await admin.from('silk_status').insert({ state, label, sublabel, source }).select('id').single();
  return data?.id ?? null;
}
export async function stepStatus(id: string | null, sublabel: string, progress: unknown = null): Promise<void> {
  if (!id) return;
  await admin.from('silk_status').update({ sublabel, progress, updated_at: new Date().toISOString() }).eq('id', id);
}
/** Finish. reported=true leaves a brief REPORTING flash (Silk wrote to journal/queue/Discord). */
export async function endStatus(id: string | null, reported = true): Promise<void> {
  if (!id) return;
  const now = new Date().toISOString();
  await admin.from('silk_status').update({ state: reported ? 'reporting' : 'idle', done_at: now, updated_at: now }).eq('id', id);
}
