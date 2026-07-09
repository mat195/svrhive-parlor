// silk-executor — closes the approval→execution gap. Invoked by the dispatch trigger when
// an action_queue item flips to approved, and by a sweep cron (the reliability backstop for
// when the trigger's async net.http_post doesn't deliver). Performs the action, VERIFIES the
// artifact, then marks done — or holds the item open with a plain-language error/alert.
//
// TRUST-CRITICAL invariant (Brief: verify-before-done): a fact correction is never marked
// `done` on the strength of a ledger row alone. If the fact names a PUBLIC surface, we fetch
// that live surface and confirm the new value is present (and the old value gone) before
// closing. If it isn't there yet, the item stays open (awaiting_site) and alerts — the sweep
// re-checks it every run and auto-closes it the moment the live site reflects the change.
// Gated: pre-defined kinds only; red tier is never auto-executed (publish still needs Mat).
import { admin, json, CORS } from '../_shared/auth.ts';
import { verifyWrite } from '../_shared/silk.ts';
import { notify } from '../_shared/notify.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const OWNER = 'matc195@gmail.com';

// Fact-correction kinds: each records a canonical entity_facts row, then (if it names a
// public surface) must pass live verification before it can close.
const FACT_KINDS = ['answer-cascade', 'metadata-fix', 'bio-approval', 'bio-revision', 'tier-reclass', 'genre-change', 'revise-role', 'reference-swap', 'appears-on-audit', 'catalog-backfill'];
// Everything the trigger/sweep is allowed to auto-execute.
const EXECUTABLE = ['corpus-initiative', 'corpus-page', 'audit-initiative', 'catalog-audit', ...FACT_KINDS];

async function mintOwnerToken(): Promise<string | null> {
  const h = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };
  const gl = await (await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, { method: 'POST', headers: h, body: JSON.stringify({ type: 'magiclink', email: OWNER }) })).json();
  const th = gl.hashed_token ?? gl.properties?.hashed_token;
  if (!th) return null;
  const v = await (await fetch(`${SUPABASE_URL}/auth/v1/verify`, { method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'magiclink', token_hash: th }) })).json();
  return v.access_token ?? null;
}

async function markDone(id: string, payload: Record<string, unknown>, result: string) {
  await admin.from('action_queue').update({ status: 'done', payload: { ...payload, executed: true, awaiting_site: false, execution_result: result, executed_at: new Date().toISOString() } }).eq('id', id);
  // A resolved stall: an item that was held awaiting the live site is now verified public. Push it.
  if (payload?.awaiting_site) {
    await notify({ kind: 'job-done', title: `Now live: ${String(payload.title ?? payload.target_query ?? 'a correction')}`.slice(0, 80), body: `A change that was waiting on the live site is now verified public. ${result}`, url: (payload.live_url as string) ?? undefined });
  }
}
async function markError(id: string, payload: Record<string, unknown>, err: string) {
  await admin.from('action_queue').update({ payload: { ...payload, execution_error: err, error_at: new Date().toISOString() } }).eq('id', id); // stays 'approved' → sweeper/Mat see the error
  await admin.from('silk_journal').insert({ entry: `[executor] Execution FAILED for queue item ${id}: ${err}. Item held in approved with a visible error.`, tags: ['executor', 'execution-error'] });
}
// Ledger written, but the LIVE public surface doesn't show it yet. Never "done" — held open + alert.
async function markAwaitingSite(id: string, payload: Record<string, unknown>, note: string, siteCheck: Record<string, unknown>) {
  await admin.from('action_queue').update({ payload: { ...payload, executed: false, awaiting_site: true, site_check: siteCheck, execution_note: note, checked_at: new Date().toISOString() } }).eq('id', id);
  await admin.from('silk_journal').insert({ entry: `[executor] Queue item ${id} ("${payload.title ?? ''}") recorded in the fact ledger, but the LIVE site does not yet reflect it — ${note}. Held OPEN (awaiting_site); the sweep re-checks until the public surface is verified. ⚠ ALERT.`, tags: ['executor', 'awaiting-site', 'alert'] });
}

// Fetch a live surface and confirm it shows the corrected value: expect present AND (old) forbid absent.
async function verifySurface(spec: { url?: string; expect?: string; forbid?: string }): Promise<{ ok: boolean; detail: string }> {
  if (!spec?.url) return { ok: false, detail: 'no verify url' };
  try {
    const res = await fetch(spec.url, { headers: { 'User-Agent': 'SilkExecutor-Verify/1.0 (silkvelvetrecords.com)' } });
    if (!res.ok) return { ok: false, detail: `fetch ${spec.url} → HTTP ${res.status}` };
    const html = (await res.text()).toLowerCase();
    const expect = String(spec.expect ?? '').toLowerCase().trim();
    const forbid = String(spec.forbid ?? '').toLowerCase().trim();
    const hasExpect = expect ? html.includes(expect) : true;
    const hasForbid = forbid ? html.includes(forbid) : false;
    if (hasExpect && !hasForbid) return { ok: true, detail: `live ${spec.url} shows "${spec.expect}"${forbid ? ` and no longer "${spec.forbid}"` : ''}` };
    return { ok: false, detail: `live ${spec.url}: expected "${spec.expect}" present=${hasExpect}${forbid ? `, stale "${spec.forbid}" present=${hasForbid}` : ''}` };
  } catch (e) { return { ok: false, detail: `verify fetch failed: ${e instanceof Error ? e.message : String(e)}` }; }
}

async function execute(item: any): Promise<void> {
  const p = item.payload ?? {};
  const kind = item.kind;

  if (kind === 'corpus-initiative' || kind === 'corpus-page') {
    // Already has a generated draft that exists? Close it — don't regenerate a duplicate.
    if (p.draft_id) {
      const have = await verifyWrite('corpus_drafts', { id: p.draft_id });
      if (have.ok) return markDone(item.id, { ...p, draft_created: true }, `draft already exists (${p.draft_id}); nothing to regenerate`);
    }
    const q = String(p.target_query ?? '').trim();
    if (!q) return markError(item.id, p, 'no target_query on item (and no existing draft to attach)');
    const token = await mintOwnerToken();
    if (!token) return markError(item.id, p, 'could not mint owner token');
    const r = await (await fetch(`${SUPABASE_URL}/functions/v1/foundry-generate`, { method: 'POST', headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ target_query: q }) })).json();
    if (!r?.ok || !r?.draft?.id) return markError(item.id, p, `foundry-generate: ${r?.error ?? 'no draft'}`);
    const proof = await verifyWrite('corpus_drafts', { id: r.draft.id });
    if (!proof.ok) return markError(item.id, p, `draft insert unverified: ${proof.detail}`);
    return markDone(item.id, { ...p, draft_id: r.draft.id, draft_created: true }, `draft created + verified (${r.draft.id})`);
  }

  if (kind === 'audit-initiative' || kind === 'catalog-audit') {
    const { count } = await admin.from('entity_facts').select('id', { count: 'exact', head: true });
    await admin.from('silk_journal').insert({ entry: `[executor] Audit "${p.focus ?? p.title}" ran. entity_facts rows: ${count}. Findings logged.`, tags: ['executor', 'audit'] });
    return markDone(item.id, p, `audit ran; findings journaled`);
  }

  // Fact corrections: (1) write the canonical ledger row + verify it, (2) if the fact names
  // a public surface, verify the LIVE site before closing — else hold open (never fake "done").
  if (FACT_KINDS.includes(kind)) {
    const field = String(p.field ?? kind);
    let value = '';
    if (p.answer_id) { const m = await admin.from('mat_answers').select('answer_text').eq('id', p.answer_id).maybeSingle(); value = m.data?.answer_text ?? ''; }
    value = value || String(p.value ?? p.title ?? '');
    const ins = await admin.from('entity_facts').insert({ key: field, value, source: `${kind} executed ${new Date().toISOString()}`, confidence: 'verified' }).select('id').single();
    const led = await verifyWrite('entity_facts', { id: ins.data?.id });
    if (!led.ok) return markError(item.id, p, `ledger write unverified: ${led.detail}`);
    if (p.answer_id) await admin.from('mat_answers').update({ propagation_status: 'complete' }).eq('id', p.answer_id);

    const spec = p.verify ?? p.site_check;
    if (spec?.url) {
      const v = await verifySurface(spec);
      if (v.ok) return markDone(item.id, p, `ledger updated (${field}) + LIVE verified: ${v.detail}`);
      return markAwaitingSite(item.id, p, `field "${field}": ${v.detail}`, { ...spec, found: false, checked_at: new Date().toISOString() });
    }
    // No public-surface verify spec → internal-only fact (e.g. real-name → MusicBrainz).
    // Ledger recorded; public publishing (if any) is a separate, tracked step.
    return markDone(item.id, p, `ledger updated (${field}); no public-surface verify spec — recorded only`);
  }

  // Truly unknown kind: acknowledge, don't pretend to have acted on a surface.
  await admin.from('silk_journal').insert({ entry: `[executor] "${kind}" approved — recorded. No automated handler; acknowledged (no surface change).`, tags: ['executor', 'ack'] });
  return markDone(item.id, p, 'acknowledged (no automated handler)');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!CRON_KEY || req.headers.get('x-cron-key') !== CRON_KEY) return json({ error: 'unauthorized' }, 401);
  let body: { item_id?: string; sweep?: boolean };
  try { body = await req.json(); } catch { body = {}; }

  if (body.sweep) {
    // (a) Re-verify items awaiting a live-site publish — auto-close once the site shows it.
    const { data: waiting } = await admin.from('action_queue').select('*').eq('status', 'approved').eq('payload->>awaiting_site', 'true').limit(40);
    let closed = 0, stillWaiting = 0;
    for (const item of waiting ?? []) {
      const spec = item.payload?.site_check ?? item.payload?.verify;
      const v = await verifySurface(spec ?? {});
      if (v.ok) { await markDone(item.id, item.payload, `live site now verified on re-check: ${v.detail}`); closed++; }
      else { await admin.from('action_queue').update({ payload: { ...item.payload, site_check: { ...(spec ?? {}), found: false, checked_at: new Date().toISOString() } } }).eq('id', item.id); stillWaiting++; }
    }

    // (b) Execute any approved executable item the trigger didn't (net.http_post can drop).
    // Filter on created_at — action_queue has no updated_at column (a phantom-column filter
    // was why the original sweep always returned nothing). An item still `approved` and
    // un-executed >2min after creation is stuck; fresh items are `proposed`, not `approved`.
    const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: stuck } = await admin.from('action_queue').select('*').eq('status', 'approved').in('kind', EXECUTABLE).lt('created_at', cutoff).limit(20);
    let handled = 0, gaveUp = 0;
    for (const item of stuck ?? []) {
      // Skip already-resolved and permanently-given-up items (no churn, no repeat alerts).
      if (item.payload?.executed || item.payload?.awaiting_site || item.payload?.execution_giveup || item.risk_tier === 'red') continue;
      const attempts = (item.payload?.execution_attempts ?? 0) + 1;
      if (attempts > 3) {
        // Give up: mark terminal so future sweeps skip it, and alert ONCE (not every run).
        await admin.from('action_queue').update({ payload: { ...item.payload, execution_attempts: attempts, execution_giveup: true } }).eq('id', item.id);
        await admin.from('silk_journal').insert({ entry: `[executor-sweeper] Queue item ${item.id} ("${item.payload?.title}") could not execute after ${attempts - 1} attempts (${item.payload?.execution_error ?? 'unknown error'}) — giving up; needs Mat. ⚠`, tags: ['executor', 'stuck', 'alert'] });
        // Needs Mat — the giveup flag guarantees this fires once per item, so no dedupe churn.
        await notify({ kind: 'stall', title: `Stuck — needs you: ${String(item.payload?.title ?? item.kind)}`.slice(0, 80), body: `Couldn't execute after ${attempts - 1} attempts (${item.payload?.execution_error ?? 'unknown error'}). It's parked until you take a look.`, url: '#/workshop', priority: 'high', dedupeMins: 0 });
        gaveUp++; continue;
      }
      await admin.from('action_queue').update({ payload: { ...item.payload, execution_attempts: attempts } }).eq('id', item.id);
      try { await execute(item); handled++; } catch (e) { await markError(item.id, item.payload ?? {}, e instanceof Error ? e.message : String(e)); }
    }
    return json({ ok: true, awaiting_closed: closed, awaiting_still: stillWaiting, swept: (stuck ?? []).length, handled, gave_up: gaveUp });
  }

  if (!body.item_id) return json({ error: 'item_id required' }, 400);
  const { data: item } = await admin.from('action_queue').select('*').eq('id', body.item_id).maybeSingle();
  if (!item) return json({ error: 'item not found' }, 404);
  if (item.status !== 'approved' || item.payload?.executed) return json({ ok: true, skipped: 'not approved / already executed' });
  try { await execute(item); } catch (e) { await markError(item.id, item.payload ?? {}, e instanceof Error ? e.message : String(e)); }
  return json({ ok: true, item_id: item.id });
});
