// answer-propagate — an answer is a teaching moment, not a row update. On submit:
//  1. mark the question answered + append to mat_answers,
//  2. compute the cascade (which entity-master field + downstream surfaces),
//  3. file ONE queue item ("review N surfaces") + a journal entry in Silk's voice,
//  4. link the journal back to the answer. Owner-only.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';

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

  // 3a. journal in Silk's voice (created first so we can link it back).
  const journalEntry = `Mat answered "${q.question}" → "${body.answer}". I read this as a confirmed fact for ${field}. It ripples to ${surfaces.length} surface(s): ${surfaces.join('; ')}. Filed a cascade for review — nothing changes those surfaces until Mat approves.`;
  const { data: jr } = await admin.from('silk_journal').insert({ entry: journalEntry, tags: ['answer', 'propagation', field] }).select('id').single();

  // 1b. append to mat_answers ledger
  const { data: ans } = await admin.from('mat_answers').insert({
    question_id: q.id, question_text: q.question, answer_text: body.answer,
    entity_master_field_touched: field, propagation_status: 'pending', journal_ref: jr?.id ?? null,
  }).select('id').single();

  // 2. file ONE cascade queue item (single approval, not many).
  await admin.from('action_queue').insert({
    kind: 'answer-cascade', status: 'proposed',
    payload: {
      title: `Answer → review ${surfaces.length} surface${surfaces.length > 1 ? 's' : ''}`,
      rationale: `You answered: "${q.question}" → "${body.answer}".\nThis updates entity-master field "${field}" and should propagate to:\n${surfaces.map((s) => '• ' + s).join('\n')}\n\nApprove to authorize the cascade (the builder applies the edits + regenerates affected kits/pages). Reject if it shouldn't propagate.`,
      answer_id: ans?.id, field, surfaces, priority: 1,
    },
  });

  return json({ ok: true, field, surfaces, journal_ref: jr?.id });
});
