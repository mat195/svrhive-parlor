// extraction-approve (Brief Six) — Mat's one-pass batch decision on distilled
// extractions. Approve routes each by type into the real retention pipeline;
// reject closes it. Superseding facts are logged before/after, never silent.
// Owner-only.
//
//   fact / correction(of a fact) → entity_facts ledger + mat_answers (propagation complete)
//   preference / correction(doctrine) → appended to the RUNTIME identity (silk_config) so
//        the very next Silk call respects it, + a doctrine-sync queue item for repo persistence
//   instinct / question → filed to silk_questions (pending) for the Question Hunter
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { verifyWrite } from '../_shared/silk.ts';

const DOCTRINE_MARKER = '## Learned from chat (runtime; pending repo-sync)';

async function sha8(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}

async function appendDoctrine(line: string): Promise<boolean> {
  const { data } = await admin.from('silk_config').select('value').eq('key', 'silk_identity').maybeSingle();
  let value = data?.value ?? '';
  if (value.includes(DOCTRINE_MARKER)) {
    value = value.replace(DOCTRINE_MARKER, `${DOCTRINE_MARKER}\n- ${line}`);
  } else {
    value = `${value.trimEnd()}\n\n${DOCTRINE_MARKER}\n- ${line}\n`;
  }
  const hash = await sha8(value);
  const { error } = await admin.from('silk_config').update({ value, hash, updated_at: new Date().toISOString() }).eq('key', 'silk_identity');
  return !error;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;

  let body: { action?: string; extraction_ids?: string[]; edits?: Record<string, { canonical?: string }> };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const action = body.action;
  const ids = body.extraction_ids ?? [];
  if (!['approve', 'reject'].includes(action ?? '') || ids.length === 0) return json({ error: 'action (approve|reject) + extraction_ids[] required' }, 400);

  const { data: rows } = await admin.from('chat_extractions').select('*').in('id', ids).eq('status', 'pending');
  const extractions = rows ?? [];
  const nowIso = new Date().toISOString();
  const results: any[] = [];

  for (const x of extractions) {
    if (action === 'reject') {
      await admin.from('chat_extractions').update({ status: 'rejected', resolved_at: nowIso }).eq('id', x.id);
      results.push({ id: x.id, type: x.extraction_type, action: 'rejected' });
      continue;
    }

    const canonical = body.edits?.[x.id]?.canonical ?? x.proposed_content?.canonical ?? x.proposed_content?.summary ?? '';
    const field = x.target_field ?? 'entity master';
    const prov = `chat extraction ${x.id} (Mat-approved ${nowIso})`;
    let routed = 'unknown';
    const proofs: string[] = [];

    // Supersession is always logged before/after.
    if (x.supersedes) {
      await admin.from('silk_journal').insert({
        entry: `Supersession (Mat-approved): ${x.supersedes.field} — "${x.supersedes.old_value}" → "${x.supersedes.new_value}". Source: chat. Old value marked superseded.`,
        tags: ['distiller', 'supersede', 'brief-six'],
      });
    }

    if (x.extraction_type === 'fact' || (x.extraction_type === 'correction' && /§|entity|fact|catalog|collab|release|identity|location|link/i.test(field))) {
      // Fact → entity_facts ledger + mat_answers teaching row (propagation complete).
      const efIns = await admin.from('entity_facts').insert({ key: field, value: canonical, source: prov, confidence: x.confidence === 'needs-review' ? 'unverified' : x.confidence }).select('id').single();
      const maIns = await admin.from('mat_answers').insert({
        question_text: x.proposed_content?.summary ?? canonical, answer_text: canonical,
        entity_master_field_touched: field, propagation_status: 'complete',
      }).select('id').single();
      const p1 = await verifyWrite('entity_facts', { id: efIns.data?.id });
      const p2 = maIns.data?.id ? await verifyWrite('mat_answers', { id: maIns.data.id }) : { ok: false, detail: 'mat_answers no id' };
      proofs.push(p1.detail, p2.detail);
      routed = 'entity_master';
    } else if (x.extraction_type === 'preference' || x.extraction_type === 'correction') {
      // Doctrine → runtime identity (immediate effect) + repo-sync queue item.
      const ok = await appendDoctrine(canonical);
      await admin.from('action_queue').insert({
        kind: 'doctrine-sync', status: 'proposed',
        payload: { title: 'Persist learned doctrine to SILK_IDENTITY.md', rationale: `From chat: "${canonical}"\n\nAlready live in the runtime identity (silk_config). This queue item is a reminder to write it into the repo file so it survives the next full config sync.`, doctrine_line: canonical, extraction_id: x.id },
      });
      proofs.push(ok ? 'doctrine appended to runtime identity (silk_config)' : 'doctrine append FAILED');
      routed = 'doctrine';
    } else {
      // instinct / question → silk_questions (pending) for the Question Hunter.
      const qIns = await admin.from('silk_questions').insert({
        question: canonical, why_asking: x.proposed_content?.summary ?? null, urgency: 4,
        status: 'pending', generated_by: 'distiller',
        source_ref: { node_key: field, from_extraction: x.id },
        question_context: { type: 'text', label: x.extraction_type === 'instinct' ? 'Strategic instinct' : 'Open question', value: canonical },
      }).select('id').single();
      const p = qIns.data?.id ? await verifyWrite('silk_questions', { id: qIns.data.id }) : { ok: false, detail: 'silk_questions no id' };
      proofs.push(p.detail);
      routed = 'silk_questions';
    }

    await admin.from('chat_extractions').update({ status: 'approved', resolved_at: nowIso }).eq('id', x.id);
    results.push({ id: x.id, type: x.extraction_type, routed, proofs });
  }

  return json({ ok: true, action, count: results.length, results });
});
