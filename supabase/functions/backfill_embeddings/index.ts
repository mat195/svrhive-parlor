// backfill_embeddings (Brief Seven, Layer 4) — embeds any silk_journal / mat_answers
// row whose embedding is still NULL. Doubles as the one-pass retro-fill AND ongoing
// coverage (light cron) so every row carries an embedding regardless of write path.
// Callable by owner (JWT) or by cron (x-cron-key header).
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { embed } from '../_shared/embed.ts';

const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';

async function backfill(table: string, textCols: string[], limit: number): Promise<{ table: string; embedded: number; remaining: number }> {
  const { data: rows } = await admin.from(table).select(`id, ${textCols.join(', ')}`).is('embedding', null).limit(limit);
  let embedded = 0;
  for (const r of rows ?? []) {
    const text = textCols.map((c) => (r as Record<string, unknown>)[c]).filter(Boolean).join('\n');
    const v = await embed(text);
    if (v) { const { error } = await admin.from(table).update({ embedding: v }).eq('id', (r as { id: string }).id); if (!error) embedded++; }
  }
  const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).is('embedding', null);
  return { table, embedded, remaining: count ?? 0 };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const cronOk = CRON_KEY && req.headers.get('x-cron-key') === CRON_KEY;
  if (!cronOk) { const auth = await requireOwner(req); if (!auth.ok) return auth.res; }

  let limit = 200;
  try { const b = await req.json(); if (b?.limit) limit = Math.min(500, b.limit); } catch { /* default */ }

  const j = await backfill('silk_journal', ['entry'], limit);
  const m = await backfill('mat_answers', ['question_text', 'answer_text'], limit);
  return json({ ok: true, silk_journal: j, mat_answers: m });
});
