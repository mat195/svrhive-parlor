// answer-propagate — an answer is a teaching moment, not a row update. On submit:
//  1. mark the question answered + append to mat_answers,
//  2. compute the cascade (which entity-master field + downstream surfaces),
//  3. file ONE queue item ("review N surfaces") + a journal entry in Silk's voice,
//  4. link the journal back to the answer. Owner-only.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { verifyWrite } from '../_shared/silk.ts';

// Map a question's node_key → (entity-master field, downstream surfaces).
function cascade(nodeKey: string): { field: string; surfaces: string[] } {
  if (nodeKey.startsWith('identity-active-since')) return { field: 'activeSince', surfaces: ['Entity master · activeSince', '25w + 100w bios', 'MusicBrainz artist begin-date', 'RateYourMusic born/formed'] };
  if (nodeKey.startsWith('identity-realname')) return { field: 'realNamePolicy', surfaces: ['MusicBrainz legal-name field', 'Wikidata legal-name'] };
  if (nodeKey.startsWith('identity-location')) return { field: 'location', surfaces: ['Entity master · location', 'Bios', 'Site descriptor', 'MusicBrainz area', 'Wikidata work-location'] };
  if (nodeKey.startsWith('platform-')) return { field: 'links', surfaces: ['Entity master · link graph', 'Site sameAs (artist page)', 'Submission kits sameAs (MB / Wikidata / Genius / Last.fm / RYM)', 'llms.txt'] };
  if (nodeKey.startsWith('collab-')) return { field: '§7 collaborators', surfaces: ['Entity master · §7 collaborator role', 'Brain collaborator node confidence', '100w bio (if a signature collaborator)'] };
  if (nodeKey.startsWith('rel-')) return { field: 'releases', surfaces: ['Entity master · §6 discography', 'Release page on site', 'MusicBrainz release'] };
  return { field: nodeKey || 'entity master', surfaces: ['Entity master'] };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;

  let body: { question_id?: string; answer?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  if (!body.question_id || !body.answer) return json({ error: 'question_id + answer required' }, 400);

  const { data: q } = await admin.from('silk_questions').select('*').eq('id', body.question_id).single();
  if (!q) return json({ error: 'question not found' }, 404);

  const nodeKey = q.source_ref?.node_key ?? '';
  const { field, surfaces } = cascade(nodeKey);
  const answeredAt = new Date().toISOString();

  // 1. mark answered
  await admin.from('silk_questions').update({ status: 'answered', answer: body.answer, answered_at: answeredAt }).eq('id', q.id);

  // Decide: does this need a SECOND decision from Mat, or did he already decide it?
  // Mat already answered the question — persisting a single-surface, non-contradicting
  // answer is NOT a second decision. Only queue when it's genuinely ambiguous:
  //   • touches 3+ surfaces, OR
  //   • contradicts an existing verified canonical fact (supersession).
  const { data: existing } = await admin.from('entity_facts').select('value').eq('key', field).eq('confidence', 'verified').limit(1);
  const contradicts = !!existing?.length && existing[0].value && existing[0].value !== body.answer;
  const shouldQueue = surfaces.length >= 3 || contradicts;

  // 3a. journal (created first so we can link it back).
  const journalEntry = shouldQueue
    ? `Mat answered "${q.question}" → "${body.answer}". Confirmed fact for ${field}, rippling to ${surfaces.length} surface(s): ${surfaces.join('; ')}. ${contradicts ? 'CONTRADICTS an existing verified fact — ' : ''}filed a cascade for your review; nothing changes those surfaces until you approve.`
    : `Mat answered "${q.question}" → "${body.answer}" — auto-applied (single surface: ${field}, no contradiction). You already decided this; I persisted it. Repo-file sync is bookkeeping (journaled, not queued).`;
  const { data: jr } = await admin.from('silk_journal').insert({ entry: journalEntry, tags: ['answer', 'propagation', field, shouldQueue ? 'queued' : 'auto-applied'] }).select('id').single();

  // 1b. append to mat_answers ledger (complete when auto-applied).
  const { data: ans } = await admin.from('mat_answers').insert({
    question_id: q.id, question_text: q.question, answer_text: body.answer,
    entity_master_field_touched: field, propagation_status: shouldQueue ? 'pending' : 'complete', journal_ref: jr?.id ?? null,
  }).select('id').single();

  if (shouldQueue) {
    await admin.from('action_queue').insert({
      kind: 'answer-cascade', status: 'proposed', risk_tier: 'amber',
      payload: {
        title: `Answer → review ${surfaces.length} surface${surfaces.length > 1 ? 's' : ''}${contradicts ? ' (contradiction)' : ''}`,
        rationale: `You answered: "${q.question}" → "${body.answer}".\nThis updates entity-master field "${field}" and should propagate to:\n${surfaces.map((s) => '• ' + s).join('\n')}\n${contradicts ? `\n⚠ This CONTRADICTS an existing verified fact ("${existing![0].value}"). Approve to supersede.\n` : ''}\nApprove to authorize the cascade. Reject if it shouldn't propagate.`,
        answer_id: ans?.id, field, surfaces, contradicts, priority: 1,
      },
    });
  } else {
    // Auto-apply: record the canonical fact now (single-surface, Mat-decided).
    await admin.from('entity_facts').insert({ key: field, value: body.answer, source: `Mat answer (Questions Strip) — auto-applied ${answeredAt}`, confidence: 'verified' });
  }

  // Voice-not-hands: confirm the two state changes landed before reporting done.
  const qProof = await verifyWrite('silk_questions', { id: q.id, status: 'answered' });
  const aProof = ans?.id ? await verifyWrite('mat_answers', { id: ans.id }) : { ok: false, detail: 'mat_answers insert returned no id' };
  if (!qProof.ok || !aProof.ok) {
    return json({ error: 'propagation unverified', question_proof: qProof.detail, answer_proof: aProof.detail }, 500);
  }

  return json({ ok: true, field, surfaces, queued: shouldQueue, auto_applied: !shouldQueue, journal_ref: jr?.id, write_proof: [qProof.detail, aProof.detail] });
});
