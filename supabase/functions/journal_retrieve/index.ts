// journal_retrieve (Brief Seven, Layer 4) — semantic episodic memory endpoint.
// Thin owner-only wrapper over the shared retrieve() (vector + recent-N + permanent).
import { requireOwner, json, CORS } from '../_shared/auth.ts';
import { retrieve } from '../_shared/journal.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;
  let body: { query?: string; top_n?: number; recent_n?: number };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body.query) return json({ error: 'query required' }, 400);
  const out = await retrieve(body.query, body.top_n ?? 6, body.recent_n ?? 5);
  return json({ ok: true, ...out });
});
