// silk-chat — the Parlor's grounded chat. Runs server-side only.
//
// Security: LLM key lives ONLY here (Edge Function secret), never in the browser.
// The browser calls this function with the signed-in user's JWT; we verify the
// caller is the owner before doing anything. Reads the ledger with the service
// role (bypassing RLS) to assemble grounding context, then streams Anthropic.
//
// Contract:
//   POST { chat_id: uuid, message: string, deep?: boolean }
//   → text/event-stream:  event: refs  → {ledger_refs}
//                         event: delta → {text}   (repeated)
//                         event: done  → {ok:true}
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildSystemPrompt } from '../_shared/prompt_builder.ts';
import { runToolLoop } from '../_shared/tools.ts';
import { asksForFetchable, usedFetchTool, verifyBeforeDone } from '../_shared/response_gates.ts';

const OWNER_EMAIL = 'matc195@gmail.com';
const CHEAP_MODEL = 'claude-haiku-4-5-20251001';
const DEEP_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 1024;
const RATE_PER_MIN = 15;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// crude in-memory sliding-window rate limit (single-user Parlor)
const hits: number[] = [];
function rateLimited(): boolean {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60_000) hits.shift();
  if (hits.length >= RATE_PER_MIN) return true;
  hits.push(now);
  return false;
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const enc = new TextEncoder();
function sse(controller: ReadableStreamDefaultController, event: string, data: unknown) {
  controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
}

function keywords(q: string): string[] {
  return [...new Set(
    q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 4),
  )].slice(0, 6);
}

async function gatherContext(question: string) {
  const refs: { kind: string; id?: string; label: string }[] = [];

  const { data: runs } = await admin
    .from('visibility_runs')
    .select('id, run_at, prompt_count, mentions_total, label_mentions_total, notes')
    .order('run_at', { ascending: false })
    .limit(2);
  if (runs?.length) refs.push({ kind: 'visibility_run', id: runs[0].id, label: `latest run ${String(runs[0].run_at).slice(0, 10)} — ${runs[0].mentions_total}/${runs[0].prompt_count}` });

  const { data: journal } = await admin
    .from('silk_journal')
    .select('id, entry, tags, created_at')
    .order('created_at', { ascending: false })
    .limit(6);
  journal?.forEach((j) => refs.push({ kind: 'journal', id: j.id, label: j.entry.slice(0, 60) }));

  const { data: queue } = await admin
    .from('action_queue')
    .select('id, kind, status, payload')
    .order('created_at', { ascending: false })
    .limit(10);

  // keyword-matched results rows
  const kws = keywords(question);
  let matched: any[] = [];
  if (kws.length) {
    const ors = kws.map((k) => `prompt.ilike.%${k}%,response_excerpt.ilike.%${k}%`).join(',');
    const { data } = await admin
      .from('visibility_results')
      .select('id, category, engine, prompt, mentioned, response_excerpt')
      .or(ors)
      .limit(8);
    matched = data ?? [];
    matched.forEach((m) => refs.push({ kind: 'result', id: m.id, label: `${m.engine}: ${m.prompt.slice(0, 48)}` }));
  }

  const ctx = [
    runs?.length ? `LATEST RUNS:\n${JSON.stringify(runs)}` : 'No battery runs yet.',
    journal?.length ? `RECENT JOURNAL:\n${journal.map((j) => '- ' + j.entry).join('\n')}` : '',
    queue?.length ? `ACTION QUEUE:\n${JSON.stringify(queue)}` : 'Action queue empty.',
    matched.length ? `MATCHED RESULT ROWS:\n${JSON.stringify(matched)}` : '',
  ].filter(Boolean).join('\n\n');

  return { ctx, refs };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

  // Verify caller is the owner (JWT from the browser session).
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false },
  });
  const { data: userData } = await userClient.auth.getUser();
  const email = userData?.user?.email;
  if (!email || email !== OWNER_EMAIL) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  if (rateLimited()) {
    return new Response(JSON.stringify({ error: 'rate_limited', retry_after_s: 60 }), { status: 429, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  let body: { chat_id?: string; message?: string; deep?: boolean };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400, headers: CORS }); }
  const rawMessage = (body.message ?? '').trim();
  if (!rawMessage) return new Response('empty message', { status: 400, headers: CORS });

  const message = rawMessage.replace(/^\/deep\b\s*/i, '');
  const model = DEEP_MODEL; // P1-5: reasoning quality is the product — strongest default.

  const { ctx, refs } = await gatherContext(message);

  // --- P0-1: Session state + referent pinning ---
  const sessionId = body.chat_id ?? 'no-session';
  let openLoops: { type: string; item_id?: string; description: string; options_offered?: string; created_at?: string }[] = [];
  if (body.chat_id) {
    const { data: ss } = await admin.from('silk_session_state').select('open_loops').eq('session_id', sessionId).maybeSingle();
    openLoops = (ss?.open_loops as typeof openLoops) ?? [];
  }
  // Short/ambiguous replies resolve against the NEWEST open loop, then trigger its action.
  const isResolution = /^\s*(approve|approved|yes|yep|yeah|ok|okay|do it|go ahead|sure|confirm|hold|iterate|reject|no|nope|the (first|second|third|1st|2nd|3rd) one|[1-3])[.!\s]*$/i.test(message);
  let resolutionNote = '';
  if (isResolution && openLoops.length) {
    const loop = openLoops[openLoops.length - 1];
    const affirm = /^\s*(approve|approved|yes|yep|yeah|ok|okay|do it|go ahead|sure|confirm|1|the first|1st)/i.test(message);
    const reject = /^\s*(reject|no|nope)/i.test(message);
    if (loop.item_id && (affirm || reject)) {
      const { data: qi } = await admin.from('action_queue').select('payload').eq('id', loop.item_id).maybeSingle();
      await admin.from('action_queue').update({ status: affirm ? 'approved' : 'rejected', payload: { ...(qi?.payload ?? {}), decided_at: new Date().toISOString() } }).eq('id', loop.item_id);
      resolutionNote = affirm
        ? `Mat replied "${message}" → this RESOLVES your open loop: "${loop.description}". You have ALREADY approved queue item ${loop.item_id} — the executor is creating the artifact now. Confirm to Mat in one line. Do NOT ask what to approve.`
        : `Mat replied "${message}" → REJECTED your open loop: "${loop.description}". Confirm briefly.`;
      await admin.from('silk_session_events').insert({ session_id: sessionId, event_type: 'resolve', description: `${affirm ? 'approved' : 'rejected'}: ${loop.description}`, item_id: loop.item_id });
      openLoops = openLoops.slice(0, -1);
    }
  }
  // Fallback (P0-1 hardening): a bare resolution with no pinned loop still resolves the
  // newest recently-proposed action (last 15 min) — so "approve" never dead-ends even
  // when Silk proposed something without formally pinning it.
  if (isResolution && !resolutionNote) {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: recent } = await admin.from('action_queue').select('id, kind, payload').eq('status', 'proposed').gte('created_at', since).order('created_at', { ascending: false }).limit(1);
    const affirm = /^\s*(approve|approved|yes|yep|yeah|ok|okay|do it|go ahead|sure|confirm)/i.test(message);
    const reject = /^\s*(reject|no|nope)/i.test(message);
    if (recent?.length && (affirm || reject)) {
      const r = recent[0];
      await admin.from('action_queue').update({ status: affirm ? 'approved' : 'rejected', payload: { ...(r.payload ?? {}), decided_at: new Date().toISOString() } }).eq('id', r.id);
      resolutionNote = affirm
        ? `Mat said "${message}" → resolved the most recent open proposal ("${r.payload?.title ?? r.kind}", ${r.id}). You have ALREADY approved it; the executor is acting now. Confirm in one line — do NOT ask what to approve.`
        : `Mat said "${message}" → rejected the most recent proposal ("${r.payload?.title ?? r.kind}"). Confirm briefly.`;
      await admin.from('silk_session_events').insert({ session_id: sessionId, event_type: 'resolve', description: `fallback ${affirm ? 'approve' : 'reject'}: ${r.payload?.title ?? r.kind}`, item_id: r.id });
    }
  }
  const openLoopsBlock = openLoops.length
    ? `--- AWAITING MAT (open loops — resolve short replies against the NEWEST) ---\n${openLoops.map((l, i) => `${i + 1}. ${l.description}${l.options_offered ? ` [${l.options_offered}]` : ''}`).join('\n')}\nShort replies like "approve"/"yes"/"2" resolve against these.\n\n`
    : '';
  const resolutionBlock = resolutionNote ? `--- LOOP RESOLUTION (act on this) ---\n${resolutionNote}\n\n` : '';

  // L-session (P1-5): current-session truth — the session log — ALWAYS at the very top,
  // before any retrieval. This is truth, never from vector recall.
  let sessionLog = '';
  if (body.chat_id) {
    const { data: evs } = await admin.from('silk_session_events').select('event_type, description').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
    if (evs?.length) sessionLog = `--- THIS SESSION (log — current-session truth, not memory) ---\n${evs.reverse().map((e) => `• [${e.event_type}] ${e.description}`).join('\n')}\n\n`;
  }

  // Route through the five-layer retrieval assembly (Brief Seven). ctx becomes the
  // compact L5 current-state snapshot; the builder handles L1-L4 + records the assembly.
  const built = await buildSystemPrompt({ surface: 'silk-chat', message, callId: body.chat_id, taskTypeHint: 'chat', ledgerSnapshot: ctx });
  const identityHash = built.identityHash;
  const assemblyId = built.assemblyId;

  const system =
    resolutionBlock + openLoopsBlock + sessionLog +
    built.system +
    '\n\n--- OPERATING RULES (Parlor) ---\n' +
    'Answer ONLY from the layered context above plus general knowledge that does not assert facts about Lucius P. Thundercat / Silk Velvet Records.\n' +
    'PROVENANCE: if your context does not contain the answer, say so plainly — do not invent. Never fabricate metrics, mentions, or facts about the artist/label.\n' +
    'Canonical name is always "Lucius P. Thundercat", never abbreviated. Lead with the number. Be concise.\n' +
    'AGENT LOOP: when you propose a concrete action (draft a corpus page, run an audit, apply a fix), call the queue_for_approval tool to FILE it — that pins it as the open loop so Mat\'s next "approve"/"yes" resolves against it and it executes. Do not just describe an action you could take; file it.';

  // Chat continuity: load the prior turns so Silk remembers the conversation (the
  // client already persisted the current user message before calling us). Without this
  // Silk answers every message in isolation.
  let history: { role: string; content: string }[] = [];
  if (body.chat_id) {
    const { data: msgs } = await admin.from('parlor_messages')
      .select('role, content, created_at').eq('chat_id', body.chat_id).neq('role', 'system')
      .order('created_at', { ascending: true }).limit(24);
    history = (msgs ?? [])
      .filter((m) => (m.content ?? '').trim())
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content as string }));
  }
  // Ensure the thread ends with the current user message, and starts with a user turn.
  if (!history.length || history[history.length - 1].content !== message || history[history.length - 1].role !== 'user') {
    history.push({ role: 'user', content: message });
  }
  while (history.length && history[0].role !== 'user') history.shift();
  // Merge accidental consecutive same-role turns (Anthropic expects alternation).
  const merged: { role: string; content: string }[] = [];
  for (const m of history) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else merged.push({ ...m });
  }
  history = merged;

  const stream = new ReadableStream({
    async start(controller) {
      sse(controller, 'refs', { ledger_refs: refs, model, identity_hash: identityHash, assembly_id: assemblyId, skills: built.skillsLoaded });
      let full = '';
      try {
        // Tool-use loop (Brief Three→Seven): Claude can call web_fetch / journal_retrieve
        // / ledger_query mid-response instead of asking Mat for retrievable data.
        // max_tokens is task-classified by the builder (err upward — truncation is worse).
        const r0 = await runToolLoop({
          system, history, model, anthropicKey: ANTHROPIC_API_KEY,
          callerJwt: jwt, maxTokens: built.maxTokens,
        });
        let text = r0.text; let toolTrace = r0.toolTrace; const stopReason = r0.stopReason;

        // P1-4 SOURCING gate: asked Mat for fetchable data without trying a tool → force one attempt.
        if (asksForFetchable(text) && !usedFetchTool(toolTrace)) {
          const fix = await runToolLoop({
            system: system + '\n\n--- SOURCING GATE (enforced) ---\nYou just asked Mat for data you can fetch yourself. Use the appropriate tool (web_fetch / spotify_* / read_config_file / ledger_query_* / journal_retrieve) NOW and answer from the result. Only ask Mat if the tool genuinely fails.',
            history, model, anthropicKey: ANTHROPIC_API_KEY, callerJwt: jwt, maxTokens: built.maxTokens,
          });
          if (fix.text && usedFetchTool(fix.toolTrace)) { text = fix.text; toolTrace = [...toolTrace, ...fix.toolTrace]; }
        }
        // P1-4 VERIFY-BEFORE-DONE gate: soften unbacked state-change claims.
        const vbd = verifyBeforeDone(text, toolTrace);
        if (vbd.softened) await admin.from('silk_journal').insert({ entry: `[gate] Softened an unverified state-change claim in chat (no confirmation tool ran this turn).`, tags: ['gate', 'verify-before-done'] });
        full = vbd.text;

        if (toolTrace.length) {
          sse(controller, 'tools', { used: toolTrace.map((t) => t.name) });
          // Session log (P0-1): current-session truth, append-only — never from retrieval.
          for (const t of toolTrace) {
            await admin.from('silk_session_events').insert({ session_id: sessionId, event_type: 'tool_call', description: `${t.name}(${JSON.stringify(t.input).slice(0, 120)})` });
            // Pin an open loop for anything Silk filed for approval.
            if (t.name === 'queue_for_approval' && (t.result as any)?.item_id) {
              openLoops.push({ type: 'approval', item_id: (t.result as any).item_id, description: (t.result as any).description ?? 'a proposed action', created_at: new Date().toISOString() });
              await admin.from('silk_session_events').insert({ session_id: sessionId, event_type: 'filing', description: (t.result as any).description, item_id: (t.result as any).item_id });
            }
          }
        }
        // Self-detected truncation → journal a config gap (never silently cut off).
        if (stopReason === 'max_tokens') {
          await admin.from('silk_journal').insert({ entry: `Truncation: a chat response hit the ${built.maxTokens}-token ceiling (task ${built.taskType}) and cut off. Config gap — this task type may need a higher tier.`, tags: ['truncation', 'config-gap', 'self-diagnostic'] });
        }
        // Chunk the final text into deltas so the UI still animates.
        const words = full.split(/(\s+)/);
        for (let i = 0; i < words.length; i += 4) sse(controller, 'delta', { text: words.slice(i, i + 4).join('') });
      } catch (e) {
        sse(controller, 'delta', { text: `\n[silk-chat exception: ${e instanceof Error ? e.message : e}]` });
      }

      // Persist assistant message with ledger_refs (append-only), if chat exists.
      if (body.chat_id && full) {
        await admin.from('parlor_messages').insert({
          chat_id: body.chat_id,
          role: 'assistant',
          content: full,
          ledger_refs: refs,
        });
      }
      // Persist session state — the open loops carry to Mat's next message (P0-1).
      if (body.chat_id) {
        await admin.from('silk_session_state').upsert({ session_id: sessionId, open_loops: openLoops.slice(-8), updated_at: new Date().toISOString() }, { onConflict: 'session_id' });
      }
      sse(controller, 'done', { ok: true, identity_hash: identityHash });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
});
