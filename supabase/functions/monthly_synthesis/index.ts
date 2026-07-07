// monthly_synthesis (Brief Seven) — first-of-month, strongest model. Reads the
// month of consolidations, battery outputs, and strategic shifts; produces a
// "state of the campaign" digest in Silk's voice and journals it as a permanent
// `exemplar` entry. Catches what weekly consolidation misses over a longer horizon.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { buildSystemPrompt } from '../_shared/prompt_builder.ts';
import { verifyWrite } from '../_shared/silk.ts';
import { startStatus, endStatus } from '../_shared/status.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const MODEL = 'claude-opus-4-8'; // strongest model, once a month

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const cronOk = CRON_KEY && req.headers.get('x-cron-key') === CRON_KEY;
  if (!cronOk) { const auth = await requireOwner(req); if (!auth.ok) return auth.res; }

  const since = new Date(Date.now() - 31 * 864e5).toISOString();
  const { data: consolidations } = await admin.from('action_queue').select('payload, created_at').eq('kind', 'weekly-consolidation').gte('created_at', since);
  const { data: journal } = await admin.from('silk_journal').select('entry, tags').gte('created_at', since).order('created_at', { ascending: false }).limit(60);
  const { data: runs } = await admin.from('visibility_runs').select('run_at, prompt_count, mentions_total, label_mentions_total').gte('run_at', since).order('run_at', { ascending: false }).limit(12);

  const statusId = await startStatus('working', 'monthly synthesis', 'monthly-synthesis', `${(journal ?? []).length} entries`);

  const corpus =
    `WEEKLY CONSOLIDATIONS:\n${(consolidations ?? []).map((c: any) => '- ' + (c.payload?.rationale ?? c.payload?.title)).join('\n') || 'none'}\n\n` +
    `BATTERY RUNS:\n${(runs ?? []).map((r) => `- ${String(r.run_at).slice(0, 10)}: ${r.mentions_total}/${r.prompt_count} (label ${r.label_mentions_total})`).join('\n') || 'none'}\n\n` +
    `JOURNAL HIGHLIGHTS:\n${(journal ?? []).slice(0, 40).map((j) => `- ${j.entry.slice(0, 160)}`).join('\n')}`;

  const built = await buildSystemPrompt({ surface: 'monthly-synthesis', message: corpus, callId: `monthly-${since.slice(0, 7)}`, taskTypeHint: 'digest' });
  const system = built.system +
    '\n\n--- MONTHLY SYNTHESIS TASK ---\nWrite a "state of the campaign" digest in your own voice: where LPT visibility stands, the strategic shifts that emerged this month, and any long-horizon capability or doctrine worth considering. Structure over prose. This becomes a permanent exemplar entry.';

  let digest = '';
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: built.maxTokens, system, messages: [{ role: 'user', content: 'Synthesize the month.' }] }),
    });
    const data = await res.json();
    digest = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  } catch (e) { await endStatus(statusId, false); return json({ error: 'synthesis failed: ' + (e instanceof Error ? e.message : String(e)) }, 500); }

  const { data: jr } = await admin.from('silk_journal').insert({ entry: `STATE OF THE CAMPAIGN (monthly synthesis):\n${digest}`, tags: ['exemplar', 'monthly-synthesis', 'state-of-campaign', 'brief-seven'] }).select('id').single();
  const proof = jr?.id ? await verifyWrite('silk_journal', { id: jr.id }) : { ok: false, detail: 'no journal id' };
  await endStatus(statusId, true);
  return json({ ok: true, digest_chars: digest.length, journal_id: jr?.id, write_proof: proof.detail });
});
