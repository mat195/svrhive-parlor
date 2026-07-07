// Shared extraction-routing (Brief Six + cleanup). Applies ONE approved/auto-applied
// chat_extraction to its destination and returns proof. Used by extraction-approve
// (Mat taps) AND conversation-distiller (auto-apply of low-stakes extractions).
import { admin } from './auth.ts';
import { verifyWrite } from './silk.ts';

const DOCTRINE_MARKER = '## Learned from chat (runtime; pending repo-sync)';
async function sha8(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 8);
}
export async function appendRule(line: string): Promise<boolean> {
  const { data } = await admin.from('silk_config').select('value').eq('key', 'silk_identity').maybeSingle();
  let value = data?.value ?? '';
  value = value.includes(DOCTRINE_MARKER)
    ? value.replace(DOCTRINE_MARKER, `${DOCTRINE_MARKER}\n- ${line}`)
    : `${value.trimEnd()}\n\n${DOCTRINE_MARKER}\n- ${line}\n`;
  const { error } = await admin.from('silk_config').update({ value, hash: await sha8(value), updated_at: new Date().toISOString() }).eq('key', 'silk_identity');
  return !error;
}

// Is this extraction low-stakes enough to auto-apply (Mat already decided it)?
// Auto when: confidence not needs-review AND it does NOT supersede an existing fact.
export function isLowStakes(x: { extraction_type: string; confidence: string; supersedes: unknown }): boolean {
  if (x.supersedes) return false;              // contradiction → Mat reviews
  if (x.confidence === 'needs-review') return false; // ambiguous → Mat reviews
  return ['fact', 'preference', 'correction', 'instinct', 'question'].includes(x.extraction_type);
}

/** Route one extraction to its home. Returns {routed, proofs}. */
export async function applyExtraction(x: any, canonicalOverride?: string): Promise<{ routed: string; proofs: string[] }> {
  const canonical = canonicalOverride ?? x.proposed_content?.canonical ?? x.proposed_content?.summary ?? '';
  const field = x.target_field ?? 'entity master';
  const prov = `chat extraction ${x.id} (${x.auto ? 'auto-applied' : 'Mat-approved'} ${new Date().toISOString()})`;
  const proofs: string[] = [];

  if (x.supersedes) {
    await admin.from('silk_journal').insert({ entry: `Supersession: ${x.supersedes.field} — "${x.supersedes.old_value}" → "${x.supersedes.new_value}" (chat).`, tags: ['distiller', 'supersede'] });
  }

  if (x.extraction_type === 'fact' || (x.extraction_type === 'correction' && /§|entity|fact|catalog|collab|release|identity|location|link/i.test(field))) {
    const ef = await admin.from('entity_facts').insert({ key: field, value: canonical, source: prov, confidence: x.confidence === 'needs-review' ? 'unverified' : x.confidence }).select('id').single();
    const ma = await admin.from('mat_answers').insert({ question_text: x.proposed_content?.summary ?? canonical, answer_text: canonical, entity_master_field_touched: field, propagation_status: 'complete' }).select('id').single();
    proofs.push((await verifyWrite('entity_facts', { id: ef.data?.id })).detail);
    if (ma.data?.id) proofs.push((await verifyWrite('mat_answers', { id: ma.data.id })).detail);
    return { routed: 'entity_master', proofs };
  }
  if (x.extraction_type === 'preference' || x.extraction_type === 'correction') {
    const ok = await appendRule(canonical);
    // repo-sync reminder is bookkeeping → journal (the queue gate would divert it anyway).
    await admin.from('silk_journal').insert({ entry: `[rules-sync] Rule live in runtime identity: "${canonical}". Claude Code to persist into skills/SILK_IDENTITY.md.`, tags: ['rules-sync', 'bookkeeping'] });
    proofs.push(ok ? 'rule appended to runtime identity' : 'rule append FAILED');
    return { routed: 'rules', proofs };
  }
  // instinct / question → the Question Hunter queue
  const qi = await admin.from('silk_questions').insert({
    question: canonical, why_asking: x.proposed_content?.summary ?? null, urgency: 4, status: 'pending', generated_by: 'distiller',
    source_ref: { node_key: field, from_extraction: x.id }, question_context: { type: 'text', label: x.extraction_type === 'instinct' ? 'Strategic instinct' : 'Open question', value: canonical },
  }).select('id').single();
  if (qi.data?.id) proofs.push((await verifyWrite('silk_questions', { id: qi.data.id })).detail);
  return { routed: 'silk_questions', proofs };
}
