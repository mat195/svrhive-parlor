// conversation-distiller (Brief Six) — turns Mat↔Silk chat into permanent memory.
// Reads new messages since the last checkpoint for a chat, extracts facts /
// preferences / corrections / instincts / questions per skills/conversation-distillation.md,
// and writes PROPOSED rows to chat_extractions for Mat's one-pass batch approval.
// Never commits canon. Owner-only.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { startStatus, endStatus } from '../_shared/status.ts';
import { verifyWrite } from '../_shared/silk.ts';
import { buildSystemPrompt } from '../_shared/prompt_builder.ts';
import { runToolLoop } from '../_shared/tools.ts';
import { applyExtraction, isLowStakes } from '../_shared/extractions.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const MODEL = 'claude-sonnet-4-6'; // precision matters — facts head for canon

const OUT_FORMAT = `Return ONLY a minified JSON object, no prose, no code fences:
{"extractions":[{
  "type":"fact|preference|correction|instinct|question",
  "summary": string (plain, one line — what Mat conveyed, his words),
  "canonical": string (how it should read in the entity master / doctrine / question, canonical form),
  "target_field": string (entity-master section like "§1 identity" / "§6 discography", or "doctrine" for preferences/corrections, or "silk_questions" for instincts/questions),
  "confidence": "verified|unverified|needs-review",
  "quote": string (short verbatim snippet of what Mat literally said),
  "msg_refs": [int] (indices from the numbered conversation below that this came from),
  "supersedes": null | {"field": string, "old_value": string, "new_value": string}
}]}
If nothing meaningful was said by Mat, return {"extractions":[]}. Empty is a correct answer.`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;

  let body: { chat_id?: string; trigger?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const chatId = body.chat_id;
  if (!chatId) return json({ error: 'chat_id required' }, 400);
  const trigger = body.trigger ?? 'debounce';

  // Checkpoint: last message already distilled for this chat.
  const { data: lastRun } = await admin.from('conversation_distiller_runs')
    .select('distilled_through_at').eq('chat_id', chatId).order('ran_at', { ascending: false }).limit(1).maybeSingle();
  const since = lastRun?.distilled_through_at ?? '1970-01-01T00:00:00Z';

  // New messages since the checkpoint (both roles for context; extract from Mat's only).
  const { data: msgs } = await admin.from('parlor_messages')
    .select('id, role, content, created_at').eq('chat_id', chatId).neq('role', 'system')
    .gt('created_at', since).order('created_at', { ascending: true });
  const rows = msgs ?? [];
  const newUser = rows.filter((m) => m.role === 'user');
  if (newUser.length === 0) {
    return json({ ok: true, extraction_count: 0, reason: 'no new Mat messages since checkpoint' });
  }

  const statusId = await startStatus('distilling', 'distilling our conversation', 'conversation-distiller', `${newUser.length} new message(s)`);

  // Numbered transcript so the model can cite message indices → we map back to ids.
  const numbered = rows.map((m, i) => `[${i}] ${m.role === 'user' ? 'MAT' : 'SILK'}: ${String(m.content).slice(0, 1200)}`).join('\n');

  // Five-layer assembly (Brief Seven): L2 gives the entity master for contradiction
  // cross-reference, L3 loads the conversation-distillation doctrine.
  const built = await buildSystemPrompt({ surface: 'conversation-distiller', message: numbered, callId: chatId, taskTypeHint: 'distillation' });
  const identityHash = built.identityHash;
  const system = built.system + '\n\n--- OUTPUT ---\n' + OUT_FORMAT;
  const user = `Distill Mat's statements from this conversation (extract ONLY from lines marked MAT). ` +
    `Anything Silk (assistant) said is context, not a source.\n\n${numbered}`;

  let extractions: any[] = [];
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { text } = await runToolLoop({ system, userText: user, model: MODEL, anthropicKey: ANTHROPIC_API_KEY, callerJwt: jwt, maxTokens: Math.max(2000, built.maxTokens) });
    const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    extractions = Array.isArray(j.extractions) ? j.extractions : [];
  } catch (e) {
    await endStatus(statusId, false);
    return json({ error: 'distillation failed: ' + (e instanceof Error ? e.message : String(e)) }, 500);
  }

  const nowIso = new Date().toISOString();
  const lastMsg = rows[rows.length - 1];

  // Insert proposed extractions (nothing touches canon here).
  const inserted: any[] = [];
  let autoApplied = 0;
  for (const x of extractions) {
    const refs: string[] = (Array.isArray(x.msg_refs) ? x.msg_refs : [])
      .map((i: number) => rows[i]?.id).filter(Boolean);
    const type = ['fact', 'preference', 'correction', 'instinct', 'question'].includes(x.type) ? x.type : 'fact';
    const conf = ['verified', 'unverified', 'needs-review'].includes(x.confidence) ? x.confidence : 'needs-review';
    // Auto-apply low-stakes extractions (Mat already said it explicitly, no ambiguity,
    // no contradiction) — persist + journal, don't surface. Only genuinely ambiguous /
    // superseding ones stay 'pending' in the notes tray for Mat's review.
    const low = isLowStakes({ extraction_type: type, confidence: conf, supersedes: x.supersedes });
    const { data: row } = await admin.from('chat_extractions').insert({
      chat_id: chatId,
      message_ids: refs,
      extraction_type: type,
      proposed_content: { summary: x.summary ?? '', canonical: x.canonical ?? '', target_field: x.target_field ?? null },
      target_field: x.target_field ?? null,
      provenance: { source: 'chat', chat_id: chatId, message_ids: refs, quote: x.quote ?? '', at: nowIso, trigger },
      confidence: conf,
      supersedes: x.supersedes ?? null,
      status: low ? 'approved' : 'pending',
      resolved_at: low ? nowIso : null,
    }).select('id, extraction_type, confidence, supersedes, target_field, proposed_content').single();
    if (!row) continue;
    if (low) {
      await applyExtraction({ ...row, auto: true });
      autoApplied++;
    } else {
      inserted.push(row); // surfaced for review
    }
  }

  // Advance the checkpoint (append-only run record).
  await admin.from('conversation_distiller_runs').insert({
    chat_id: chatId,
    distilled_through_message_id: lastMsg.id,
    distilled_through_at: lastMsg.created_at,
    extraction_count: inserted.length,
    notes: `trigger=${trigger}; ${newUser.length} new Mat msg(s); ${inserted.length} extraction(s)`,
  });

  // Voice-not-hands: prove the surfaced extractions landed.
  const proof = await verifyWrite('chat_extractions', { chat_id: chatId, status: 'pending' }, inserted.length || 0);

  await admin.from('silk_journal').insert({
    entry: `Distilled our conversation → ${autoApplied} auto-applied (you already said it — persisted, not surfaced) + ${inserted.length} surfaced for review${inserted.length ? ` (${inserted.map((r) => r.extraction_type).join(', ')} — ambiguous/contradiction/multi-surface)` : ''}.`,
    tags: ['distiller', 'retention', 'auto-apply'],
  });

  await endStatus(statusId, inserted.length > 0 || autoApplied > 0);
  return json({ ok: true, surfaced: inserted.length, auto_applied: autoApplied, extractions: inserted, identity_hash: identityHash, write_proof: proof.detail });
});
