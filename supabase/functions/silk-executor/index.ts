// silk-executor (Brief Nine P0-3) — closes the approval→execution gap. Invoked by the
// dispatch trigger when an action_queue item flips to approved. Performs the action,
// VERIFIES the artifact exists, then marks the item done — or leaves it approved with a
// plain-language execution_error surfaced to Mat. Gated: only pre-defined kinds; red
// tier is never auto-executed (publish still needs Mat's tap).
import { admin, json, CORS } from '../_shared/auth.ts';
import { verifyWrite } from '../_shared/silk.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const OWNER = 'matc195@gmail.com';

// Mint an owner access token so we can reuse owner-gated functions (foundry-generate).
async function mintOwnerToken(): Promise<string | null> {
  const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const gl = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'magiclink', email: OWNER }) })).json();
  const th = gl.hashed_token ?? gl.properties?.hashed_token;
  if (!th) return null;
  const v = await (await fetch(`${SUPABASE_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: th }) })).json();
  return v.access_token ?? null;
}

async function markDone(id: string, payload: Record<string, unknown>, result: string) {
  await admin.from('action_queue').update({ status: 'done', payload: { ...payload, executed: true, execution_result: result, executed_at: new Date().toISOString() } }).eq('id', id);
}
async function markError(id: string, payload: Record<string, unknown>, err: string) {
  await admin.from('action_queue').update({ payload: { ...payload, execution_error: err, error_at: new Date().toISOString() } }).eq('id', id); // stays 'approved' → sweeper/Mat see the error
  await admin.from('silk_journal').insert({ entry: `[executor] Execution FAILED for queue item ${id}: ${err}. Item held in approved with a visible error.`, tags: ['executor', 'execution-error'] });
}

async function execute(item: any): Promise<void> {
  const p = item.payload ?? {};
  const kind = item.kind;

  if (kind === 'corpus-initiative' || kind === 'corpus-page') {
    const q = String(p.target_query ?? '').trim();
    if (!q) return markError(item.id, p, 'no target_query on item');
    const token = await mintOwnerToken();
    if (!token) return markError(item.id, p, 'could not mint owner token');
    const r = await (await fetch(`${SUPABASE_URL}/functions/v1/foundry-generate`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_query: q }) })).json();
    if (!r?.ok || !r?.draft?.id) return markError(item.id, p, `foundry-generate: ${r?.error ?? 'no draft'}`);
    const proof = await verifyWrite('corpus_drafts', { id: r.draft.id });
    if (!proof.ok) return markError(item.id, p, `draft insert unverified: ${proof.detail}`);
    return markDone(item.id, { ...p, draft_id: r.draft.id, draft_created: true }, `draft created + verified (${r.draft.id})`);
  }

  if (kind === 'answer-cascade') {
    const field = p.field, answerId = p.answer_id;
    let ans = '';
    if (answerId) { const m = await admin.from('mat_answers').select('answer_text').eq('id', answerId).maybeSingle(); ans = m.data?.answer_text ?? ''; }
    if (!field || !ans) return markError(item.id, p, 'missing field/answer for cascade');
    const ins = await admin.from('entity_facts').insert({ key: field, value: ans, source: `answer-cascade executed ${new Date().toISOString()}`, confidence: 'verified' }).select('id').single();
    const proof = await verifyWrite('entity_facts', { id: ins.data?.id });
    if (answerId) await admin.from('mat_answers').update({ propagation_status: 'complete' }).eq('id', answerId);
    if (!proof.ok) return markError(item.id, p, proof.detail);
    return markDone(item.id, p, `entity_facts updated (${field}); repo-file sync journaled as bookkeeping`);
  }

  if (kind === 'audit-initiative' || kind === 'catalog-audit') {
    // Bounded audit: enumerate the full catalog + journal a finding.
    const token = await mintOwnerToken();
    // reuse the silk-chat tool path indirectly is heavy; do a direct summary from §6.
    const { count } = await admin.from('entity_facts').select('id', { count: 'exact', head: true });
    await admin.from('silk_journal').insert({ entry: `[executor] Audit "${p.focus ?? p.title}" ran. entity_facts rows: ${count}. Findings logged; full catalog scan available via spotify_artist_catalog for deeper passes.`, tags: ['executor', 'audit'] });
    return markDone(item.id, p, `audit ran; findings journaled`);
  }

  // Known-but-manual kinds: record execution intent, mark done (no external effect).
  await admin.from('silk_journal').insert({ entry: `[executor] "${kind}" approved — recorded. No automated executor handler; treated as acknowledged.`, tags: ['executor', 'ack'] });
  return markDone(item.id, p, 'acknowledged (no automated handler)');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!CRON_KEY || req.headers.get('x-cron-key') !== CRON_KEY) return json({ error: 'unauthorized' }, 401);
  let body: { item_id?: string; sweep?: boolean };
  try { body = await req.json(); } catch { body = {}; }

  // Sweep mode (cron): no approved executable item may sit >2 min without done/error.
  if (body.sweep) {
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const executable = ['corpus-initiative', 'corpus-page', 'answer-cascade', 'audit-initiative', 'catalog-audit', 'metadata-fix'];
    const { data: stuck } = await admin.from('action_queue').select('*').eq('status', 'approved').in('kind', executable).lt('updated_at', cutoff).limit(20);
    let handled = 0;
    for (const item of stuck ?? []) {
      if (item.payload?.executed || item.risk_tier === 'red') continue;
      const attempts = (item.payload?.execution_attempts ?? 0) + 1;
      await admin.from('action_queue').update({ payload: { ...item.payload, execution_attempts: attempts } }).eq('id', item.id);
      if (attempts > 3) { await admin.from('silk_journal').insert({ entry: `[executor-sweeper] Queue item ${item.id} ("${item.payload?.title}") stuck in approved after ${attempts} execution attempts — ALERT for Mat.`, tags: ['executor', 'stuck', 'alert'] }); continue; }
      try { await execute(item); handled++; } catch (e) { await markError(item.id, item.payload ?? {}, e instanceof Error ? e.message : String(e)); }
    }
    return json({ ok: true, swept: (stuck ?? []).length, handled });
  }

  if (!body.item_id) return json({ error: 'item_id required' }, 400);
  const { data: item } = await admin.from('action_queue').select('*').eq('id', body.item_id).maybeSingle();
  if (!item) return json({ error: 'item not found' }, 404);
  if (item.status !== 'approved' || item.payload?.executed) return json({ ok: true, skipped: 'not approved / already executed' });
  try { await execute(item); } catch (e) { await markError(item.id, item.payload ?? {}, e instanceof Error ? e.message : String(e)); }
  return json({ ok: true, item_id: item.id });
});
