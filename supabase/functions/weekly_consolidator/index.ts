// weekly_consolidator (Brief Seven) — Sunday consolidation loop. Reads the week's
// journal + answers, finds patterns, and files ONE queue item proposing: lessons to
// promote (journal → skill file = permanent capability), doctrine clarifications,
// and raw entries to archive. Mat approves in one pass; Claude Code applies.
// This is a real decision for Mat (not bookkeeping), so it belongs in his queue.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { buildSystemPrompt } from '../_shared/prompt_builder.ts';
import { verifyWrite } from '../_shared/silk.ts';
import { startStatus, endStatus } from '../_shared/status.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const MODEL = 'claude-sonnet-4-6';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const cronOk = CRON_KEY && req.headers.get('x-cron-key') === CRON_KEY;
  if (!cronOk) { const auth = await requireOwner(req); if (!auth.ok) return auth.res; }

  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const { data: journal } = await admin.from('silk_journal').select('id, entry, tags, created_at').gte('created_at', since).order('created_at', { ascending: false });
  const { data: answers } = await admin.from('mat_answers').select('question_text, answer_text, entity_master_field_touched').gte('created_at', since);
  const jrows = journal ?? [], arows = answers ?? [];
  if (jrows.length === 0 && arows.length === 0) return json({ ok: true, note: 'no activity this week — no consolidation' });

  const statusId = await startStatus('working', 'weekly consolidation', 'weekly-consolidator', `${jrows.length} entries`);

  const corpus =
    `JOURNAL (${jrows.length}):\n${jrows.map((j) => `- [${(j.tags ?? []).join(',')}] ${j.entry}`).join('\n')}\n\n` +
    `ANSWERS (${arows.length}):\n${arows.map((a) => `- ${a.question_text} → ${a.answer_text}`).join('\n')}`;

  const built = await buildSystemPrompt({ surface: 'weekly-consolidator', message: corpus, callId: `weekly-${since.slice(0, 10)}`, taskTypeHint: 'digest' });
  const system = built.system +
    '\n\n--- WEEKLY CONSOLIDATION TASK ---\nFind patterns across this week. Output ONLY minified JSON: ' +
    '{"summary":string (Silk voice, 2-3 lines),"promotions":[{"lesson":string,"target_skill":string (skill file it should live in)}],"doctrine_additions":[string (clarifications to SILK_IDENTITY.md)],"archive_candidates":[string (journal ids captured elsewhere, safe to archive)]}. ' +
    'Only propose a promotion if a lesson recurred or is durable capability. Empty arrays are fine.';

  let out = { summary: '', promotions: [] as any[], doctrine_additions: [] as string[], archive_candidates: [] as string[] };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: built.maxTokens, system, messages: [{ role: 'user', content: 'Consolidate this week.' }] }),
    });
    const data = await res.json();
    const text = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    out = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (e) { await endStatus(statusId, false); return json({ error: 'consolidation failed: ' + (e instanceof Error ? e.message : String(e)) }, 500); }

  const nP = out.promotions?.length ?? 0, nD = out.doctrine_additions?.length ?? 0, nA = out.archive_candidates?.length ?? 0;
  const { data: qi } = await admin.from('action_queue').insert({
    kind: 'weekly-consolidation', status: 'proposed',
    payload: {
      title: `Weekly consolidation — ${nP} promotion${nP !== 1 ? 's' : ''}, ${nD} doctrine, ${nA} to archive`,
      rationale: out.summary, promotions: out.promotions, doctrine_additions: out.doctrine_additions,
      archive_candidates: out.archive_candidates, priority: 2,
    },
  }).select('id').single();

  const proof = qi?.id ? await verifyWrite('action_queue', { id: qi.id }) : { ok: false, detail: 'no queue id' };
  await admin.from('silk_journal').insert({ entry: `Weekly consolidation: ${out.summary || 'reviewed the week'} — proposed ${nP} promotion(s), ${nD} doctrine addition(s), ${nA} archive(s) for your one-pass review.`, tags: ['consolidation', 'weekly', 'brief-seven'] });
  await endStatus(statusId, true);
  return json({ ok: true, promotions: nP, doctrine_additions: nD, archive_candidates: nA, write_proof: proof.detail });
});
