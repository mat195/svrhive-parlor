// workshop_initiative (overnight, 6:00 Montréal) — Silk's daily self-directed
// initiatives. Per the committed schedule: up to 3 corpus proposals + 1 audit + 1
// strategic question. Reads battery/Watchtower/cited-domains/corpus-history/entity
// TODOs/queue state. Never duplicates existing pending items. Honesty clause:
// proposes FEWER if fewer are high-leverage. generated_by='workshop_initiative'.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { buildSystemPrompt } from '../_shared/prompt_builder.ts';
import { verifyWrite, loadConfig } from '../_shared/silk.ts';
import { startStatus, endStatus } from '../_shared/status.ts';
import { riskTier } from '../_shared/risk.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const MODEL = 'claude-sonnet-4-6';
const norm = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const cronOk = CRON_KEY && req.headers.get('x-cron-key') === CRON_KEY;
  if (!cronOk) { const auth = await requireOwner(req); if (!auth.ok) return auth.res; }

  const statusId = await startStatus('working', 'hunting daily initiatives', 'workshop-initiative');

  // Context.
  const { data: runs } = await admin.from('visibility_runs').select('id, run_at, prompt_count, mentions_total, label_mentions_total').order('run_at', { ascending: false }).limit(1);
  const { data: gaps } = await admin.from('visibility_results').select('category, engine, prompt, mentioned').eq('mentioned', false).limit(30);
  const { data: drafts } = await admin.from('corpus_drafts').select('target_query, status');
  const { data: pendingQ } = await admin.from('action_queue').select('kind, payload').eq('status', 'proposed');
  const { data: pendingQuestions } = await admin.from('silk_questions').select('question').eq('status', 'pending');
  const entityMaster = (await loadConfig('entity_master')).value;
  const todos = (entityMaster.match(/TODO\(Mat\)[^\n]*/g) ?? []).slice(0, 12);

  // Dedup sets.
  const existingCorpus = new Set([...(drafts ?? []).map((d) => norm(d.target_query)), ...(pendingQ ?? []).filter((q) => q.payload?.target_query).map((q) => norm(q.payload.target_query))]);
  const existingQuestions = new Set((pendingQuestions ?? []).map((q) => norm(q.question)));

  const ctx = [
    runs?.length ? `LATEST BATTERY: ${runs[0].mentions_total}/${runs[0].prompt_count} (label ${runs[0].label_mentions_total})` : 'No battery run yet.',
    gaps?.length ? `UN-WON QUERIES (mentioned=false):\n${gaps.map((g) => `- [${g.category}/${g.engine}] ${g.prompt}`).join('\n')}` : '',
    `EXISTING CORPUS (do NOT duplicate): ${[...(drafts ?? []).map((d) => d.target_query)].join(' · ') || 'none'}`,
    `PENDING QUEUE ITEMS: ${(pendingQ ?? []).length}`,
    todos.length ? `ENTITY MASTER TODOs:\n${todos.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const built = await buildSystemPrompt({ surface: 'workshop-initiative', message: ctx, callId: `initiative-${new Date().toISOString().slice(0, 10)}`, taskTypeHint: 'digest' });
  const system = built.system +
    '\n\n--- DAILY INITIATIVE TASK ---\nPropose up to 3 corpus pages + up to 1 audit + up to 1 strategic question — ONLY the high-leverage ones. ' +
    'If fewer are genuinely worth Mat\'s attention, propose fewer (honesty over quota). Never propose a corpus page whose target query already exists. ' +
    'Output ONLY minified JSON: {"corpus":[{"target_query":string,"rationale":string (3 sentences: query, who wins now, expected impact)}],"audit":{"focus":string,"rationale":string}|null,"question":{"question":string,"why_asking":string}|null,"note":string (Silk voice, 1 line)}';

  let out = { corpus: [] as any[], audit: null as any, question: null as any, note: '' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: built.maxTokens, system, messages: [{ role: 'user', content: 'Hunt today\'s initiatives.' }] }),
    });
    const data = await res.json();
    const text = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    out = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (e) { await endStatus(statusId, false); return json({ error: 'initiative hunt failed: ' + (e instanceof Error ? e.message : String(e)) }, 500); }

  let filed = 0;
  const ids: string[] = [];
  // Corpus (dedup, max 3).
  for (const c of (out.corpus ?? []).slice(0, 3)) {
    if (!c?.target_query || existingCorpus.has(norm(c.target_query))) continue;
    existingCorpus.add(norm(c.target_query));
    const { data } = await admin.from('action_queue').insert({ kind: 'corpus-initiative', status: 'proposed', risk_tier: riskTier('corpus-initiative'), payload: { title: `Corpus page: ${c.target_query}`, target_query: c.target_query, rationale: c.rationale, generated_by: 'workshop_initiative', priority: 2 } }).select('id').single();
    if (data?.id) { filed++; ids.push(data.id); }
  }
  // Audit (max 1).
  if (out.audit?.focus) {
    const { data } = await admin.from('action_queue').insert({ kind: 'audit-initiative', status: 'proposed', risk_tier: riskTier('audit-initiative'), payload: { title: `Audit: ${out.audit.focus}`, focus: out.audit.focus, rationale: out.audit.rationale, generated_by: 'workshop_initiative', priority: 2 } }).select('id').single();
    if (data?.id) { filed++; ids.push(data.id); }
  }
  // Strategic question (dedup, max 1).
  if (out.question?.question && !existingQuestions.has(norm(out.question.question))) {
    const { data } = await admin.from('silk_questions').insert({ question: out.question.question, why_asking: out.question.why_asking ?? null, status: 'pending', generated_by: 'workshop_initiative', urgency: 5, question_context: { type: 'text', label: 'Strategic', value: out.question.question }, source_ref: { origin: 'workshop_initiative' } }).select('id').single();
    if (data?.id) filed++;
  }

  const proof = ids.length ? await verifyWrite('action_queue', { id: ids[0] }) : { ok: true, detail: 'no queue rows to verify' };
  await admin.from('silk_journal').insert({ entry: `Overnight initiatives: ${out.note || 'reviewed the board'} — filed ${filed} proposal(s) (generated_by=workshop_initiative) for the Workshop.`, tags: ['workshop', 'initiative', 'overnight'] });
  await endStatus(statusId, filed > 0);
  return json({ ok: true, filed, note: out.note, write_proof: proof.detail });
});
