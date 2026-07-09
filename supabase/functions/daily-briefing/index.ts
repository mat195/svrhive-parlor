// daily-briefing (07:30 UTC) — a genuine morning synthesis, not a metrics dump. Silk reads
// what moved in the battery overnight, what's stalled, and what's worth Mat's 5 minutes today,
// then pushes ONE proactive notification (kind='briefing') to the floating widget + logs it to
// the journal. This is the clearest "Silk did real work while you slept" signal. Cheap: one
// Claude call. Cron-key OR owner authed (so Mat can also trigger it manually to preview).
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';
import { buildSystemPrompt } from '../_shared/prompt_builder.ts';
import { startStatus, endStatus } from '../_shared/status.ts';
import { notify } from '../_shared/notify.ts';

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;
const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const MODEL = 'claude-sonnet-4-6';
const DAY = 24 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const cronOk = CRON_KEY && req.headers.get('x-cron-key') === CRON_KEY;
  if (!cronOk) { const auth = await requireOwner(req); if (!auth.ok) return auth.res; }

  const statusId = await startStatus('working', 'writing the morning briefing', 'daily-briefing');
  const nowIso = new Date().toISOString();

  // ── Context: battery movement, stalls, the board, what's un-won ──────────────
  const { data: runs } = await admin.from('visibility_runs')
    .select('run_at, prompt_count, mentions_total, label_mentions_total').order('run_at', { ascending: false }).limit(2);
  const latest = runs?.[0], prev = runs?.[1];
  const batteryLine = latest
    ? `Latest battery ${String(latest.run_at).slice(0, 10)}: ${latest.mentions_total}/${latest.prompt_count} mentions (label ${latest.label_mentions_total})`
      + (prev ? `; previous ${prev.mentions_total}/${prev.prompt_count} (Δ mentions ${latest.mentions_total - prev.mentions_total}, Δ label ${latest.label_mentions_total - prev.label_mentions_total}).` : ' (first run).')
    : 'No battery has run yet.';

  // Stalls: approved/awaiting items sitting > 2 days without reaching the site.
  const { data: stalled } = await admin.from('action_queue')
    .select('id, kind, status, created_at, payload')
    .in('status', ['approved', 'awaiting_site', 'executing'])
    .lt('created_at', new Date(Date.now() - 2 * DAY).toISOString()).order('created_at', { ascending: true }).limit(10);
  const stallLine = (stalled ?? []).length
    ? `STALLED (>2d, not yet live):\n${(stalled ?? []).map((s) => `- ${s.kind} [${s.status}] ${s.payload?.target_query ?? s.payload?.title ?? s.id.slice(0, 8)} (since ${String(s.created_at).slice(0, 10)})`).join('\n')}`
    : 'No stalled items — the pipeline is clear.';

  const { data: proposed } = await admin.from('action_queue').select('kind, payload').eq('status', 'proposed').limit(12);
  const boardLine = (proposed ?? []).length
    ? `AWAITING YOUR CALL (${proposed!.length}): ${(proposed ?? []).map((p) => p.payload?.target_query ?? p.payload?.title ?? p.kind).slice(0, 8).join(' · ')}`
    : 'Nothing waiting on your approval.';

  const { data: gaps } = await admin.from('visibility_results').select('prompt, category').eq('mentioned', false).limit(12);
  const gapLine = (gaps ?? []).length ? `STILL UN-WON: ${(gaps ?? []).map((g) => g.prompt).slice(0, 8).join(' · ')}` : '';

  const { data: recentJournal } = await admin.from('silk_journal').select('entry').order('created_at', { ascending: false }).limit(8);
  const journalLine = (recentJournal ?? []).length ? `RECENT ACTIVITY:\n${(recentJournal ?? []).map((j) => `- ${j.entry}`).join('\n')}` : '';

  const ctx = [batteryLine, stallLine, boardLine, gapLine, journalLine].filter(Boolean).join('\n\n');

  const built = await buildSystemPrompt({ surface: 'daily-briefing', message: ctx, callId: `briefing-${nowIso.slice(0, 10)}`, taskTypeHint: 'digest' });
  const system = built.system +
    '\n\n--- MORNING BRIEFING TASK ---\nWrite Mat a short morning briefing in your own voice. Three beats, tight: ' +
    '(1) WHAT MOVED — the single most important change in the battery/pipeline overnight (or "held steady" if nothing did — say so plainly, do not invent movement). ' +
    '(2) WHAT\'S STALLED — anything stuck that needs a nudge, or "nothing stuck". ' +
    '(3) WORTH 5 MINUTES — the one thing you\'d have Mat look at today, and why. If the board is quiet, say the honest thing: rest day. ' +
    'Be specific with numbers. No filler, no "good morning" throat-clearing. ' +
    'Output ONLY minified JSON: {"headline":string (<=60 chars, the one-line the notification shows),"body":string (3 short beats, plain text, <=600 chars),"priority":"normal"|"high" (high ONLY if something is genuinely time-sensitive or broken)}';

  let out = { headline: '', body: '', priority: 'normal' as 'normal' | 'high' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: built.maxTokens, system, messages: [{ role: 'user', content: 'Write this morning\'s briefing.' }] }),
    });
    const data = await res.json();
    const text = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    out = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch (e) { await endStatus(statusId, false); return json({ error: 'briefing failed: ' + (e instanceof Error ? e.message : String(e)) }, 500); }

  const headline = (out.headline || 'Morning briefing').slice(0, 80);
  // dedupeMins 0 → always push (one briefing per morning is the intent; each is distinct anyway).
  const pushed = await notify({ kind: 'briefing', title: headline, body: out.body ?? '', priority: out.priority === 'high' ? 'high' : 'normal', dedupeMins: 60 });
  await admin.from('silk_journal').insert({ entry: `Morning briefing: ${headline}${out.body ? ' — ' + out.body.slice(0, 200) : ''}`, tags: ['briefing', 'proactive', 'overnight'] });
  await endStatus(statusId, true);
  return json({ ok: true, headline, pushed: pushed.pushed, body: out.body });
});
