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
import { asksForFetchable, usedFetchTool, verifyBeforeDone, needsReformat, reformat, shouldSelfVerify, selfVerify } from '../_shared/response_gates.ts';
import { loadConfig } from '../_shared/silk.ts';

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

  let body: { chat_id?: string; message?: string; deep?: boolean; images?: { media_type: string; data: string }[]; pinned_draft_id?: string };
  try { body = await req.json(); } catch { return new Response('bad json', { status: 400, headers: CORS }); }
  const rawMessage = (body.message ?? '').trim();
  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  if (!rawMessage && !hasImages) return new Response('empty message', { status: 400, headers: CORS });

  const message = (rawMessage || 'Read the numbers in this image and report them.').replace(/^\/deep\b\s*/i, '');
  const model = DEEP_MODEL; // P1-5: reasoning quality is the product — strongest default.

  const { ctx, refs } = await gatherContext(message);

  // --- P0-1: Session state + referent pinning ---
  const sessionId = body.chat_id ?? 'no-session';
  let openLoops: { type: string; item_id?: string; description: string; options_offered?: string; created_at?: string }[] = [];
  if (body.chat_id) {
    const { data: ss } = await admin.from('silk_session_state').select('open_loops').eq('session_id', sessionId).maybeSingle();
    openLoops = (ss?.open_loops as typeof openLoops) ?? [];
    // Self-heal (root-cause fix): a loop whose queue item is already in a terminal status must
    // NEVER re-surface — regardless of HOW it got resolved (regex path, a resolve_loop tool
    // call, or a manual close). This is why a confirmed/journaled answer used to keep coming
    // back: nothing dropped it from open_loops. Now the actual queue state is the source of truth.
    const loopIds = openLoops.map((l) => l.item_id).filter(Boolean) as string[];
    if (loopIds.length) {
      const { data: term } = await admin.from('action_queue').select('id').in('id', loopIds).in('status', ['approved', 'rejected', 'resolved', 'done', 'published']);
      const closed = new Set((term ?? []).map((r) => r.id as string));
      openLoops = openLoops.filter((l) => !l.item_id || !closed.has(l.item_id));
    }
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
    } else if (!loop.item_id) {
      // Conversational question loop (no queue item) — Mat's short reply IS the answer to
      // the question Silk asked one message ago. This is the case that kept failing.
      resolutionNote = `Mat's message "${message}" is his ANSWER to the question you asked him one message ago:\n  "${loop.description}"\nYou already have BOTH the question (above) and his answer ("${message}") — do NOT look either up in any table or tool; everything you need is right here. Just apply his answer to that specific question and confirm in one line. Do NOT reinterpret it as a new request or start an unrelated task, scan, or report.`;
      await admin.from('silk_session_events').insert({ session_id: sessionId, event_type: 'resolve', description: `answered: ${loop.description}` });
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
    ? `--- AWAITING MAT · OPEN LOOPS (newest last) ---\n${openLoops.map((l, i) => `${i + 1}. ${l.description}${l.options_offered ? ` [${l.options_offered}]` : ''}`).join('\n')}\n` +
      `BINDING RULE: if Mat's message is short or ambiguous (e.g. "yes", "no", "ok", "sure", "do it", "hold", a single number, or a bare name), it is almost certainly ANSWERING the NEWEST loop above. Resolve it against that loop FIRST, before considering any other interpretation. Do NOT start a new/unrelated task in response to a short reply.\n\n`
    : '';
  const resolutionBlock = resolutionNote ? `--- LOOP RESOLUTION · DO THIS FIRST ---\n${resolutionNote}\nThis is the single most important instruction for this turn. Ignore any impulse to run an unrelated report or scan.\n\n` : '';

  // L-session (P1-5): current-session truth — the session log — ALWAYS at the very top,
  // before any retrieval. This is truth, never from vector recall.
  let sessionLog = '';
  if (body.chat_id) {
    const { data: evs } = await admin.from('silk_session_events').select('event_type, description').eq('session_id', sessionId).order('created_at', { ascending: false }).limit(10);
    if (evs?.length) sessionLog = `--- THIS SESSION (log — current-session truth, not memory) ---\n${evs.reverse().map((e) => `• [${e.event_type}] ${e.description}`).join('\n')}\n\n`;
  }

  // Pinned draft (Workshop "Discuss this draft"): Mat is conversing about ONE specific
  // corpus draft. Ground the whole turn in it so short replies resolve against it, and give
  // Silk the revise_draft tool path to apply an agreed change through the normal pipeline.
  let pinnedBlock = '';
  if (body.pinned_draft_id) {
    const { data: pd } = await admin.from('corpus_drafts')
      .select('id, target_query, status, rationale, markdown_body').eq('id', body.pinned_draft_id).maybeSingle();
    if (pd) {
      pinnedBlock = `\n\n--- DRAFT UNDER DISCUSSION (id ${pd.id}) ---\n` +
        `Mat opened this specific corpus draft to discuss it with you. Ground EVERY reply this turn in it; a short reply from Mat ("why?", "make it shorter", "yes") refers to THIS draft, not any other loop.\n` +
        `Target query: "${pd.target_query}" · status: ${pd.status}\n` +
        `Rationale for the page: ${pd.rationale ?? '—'}\n` +
        `CURRENT DRAFT BODY:\n${String(pd.markdown_body ?? '').slice(0, 6500)}\n\n` +
        `Talk it through conversationally — explain your phrasing, weigh alternatives, negotiate wording. When (and only when) Mat AGREES to a specific change, call the revise_draft tool with draft_id="${pd.id}" and a clear plain-language note; that applies it via the normal revise pipeline and versions it. Then tell him it's updated and to review the live preview. Keep changes scoped to what he agreed — don't rewrite the whole page for a small ask.`;
    }
  }

  // Route through the five-layer retrieval assembly (Brief Seven). ctx becomes the
  // compact L5 current-state snapshot; the builder handles L1-L4 + records the assembly.
  const built = await buildSystemPrompt({ surface: 'silk-chat', message, callId: body.chat_id, taskTypeHint: 'chat', ledgerSnapshot: ctx });
  const identityHash = built.identityHash;
  const assemblyId = built.assemblyId;

  const operatingRules =
    '\n\n--- OPERATING RULES (Parlor) ---\n' +
    'Answer ONLY from the layered context above plus general knowledge that does not assert facts about Lucius P. Thundercat / Silk Velvet Records.\n' +
    'PROVENANCE: if your context does not contain the answer, say so plainly — do not invent. Never fabricate metrics, mentions, or facts about the artist/label.\n' +
    'CHECK, DON\'T GUESS: for any question about actual system/data state — what\'s in a table, a worker\'s checkpoint, queue items, drafts, metrics, journal, counts, "is X still true" — the query_database tool is your DEFAULT and first move. Run a SELECT before answering; if you don\'t know the table/column, discover it via information_schema, don\'t ask Mat. Only fall back to the older per-table ledger tools if they\'re a better fit. Never state a data fact you could have queried.\n' +
    'Canonical name is always "Lucius P. Thundercat", never abbreviated. Lead with the number. Be concise.\n' +
    'AGENT LOOP: when you propose a concrete action (draft a corpus page, run an audit, apply a fix), call the queue_for_approval tool to FILE it — that pins it as the open loop so Mat\'s next "approve"/"yes" resolves against it and it executes. Do not just describe an action you could take; file it.\n' +
    'COMMAND SURFACE: this chat is Mat\'s PRIMARY way to run the campaign, not a side discussion. When he tells you what to do in plain language — "fix this", "tighten the opening", "post it", "can we publish this one", "drop that artist", "resolve that" — you DO it by calling the right tool yourself (revise_draft, publish_draft, resolve_loop, queue_for_approval), not by telling him to click a button elsewhere. If a draft is pinned, act on THAT draft.\n' +
    'ALWAYS CONFIRM WHAT YOU DID (never a silent state change): every reply that touches state must say, in plain language — (a) what you understood the request to be, (b) what you ACTUALLY did with the real outcome (which tool, the concrete result: "revised the opening to one sentence", "published — live at <url>", "held it: the provenance gate flagged X"), and (c) what\'s next, if anything. If you could not do it, say so and why. Mat should never have to go look at a card to find out what happened.\n' +
    'CLOSE WHAT\'S SETTLED: when Mat confirms, approves, answers, or rejects something you filed — even in a full sentence, not just "yes" — you MUST call resolve_loop on that item_id to flip its real status. Saying "confirmed" or journaling it does NOT close it; only resolve_loop stops it re-surfacing. If you don\'t know the item_id, query action_queue for the matching proposed item first.\n' +
    'PUBLISH FROM CHAT: "can we post this?" is yours to answer. Publishing runs a provenance gate inside publish_draft — call it; if it passes it goes live and you report the URL, if it blocks you report the reason plainly. Only publish on Mat\'s clear go-ahead; if something genuinely blocks it, ask the ONE question that unblocks it — never leave him staring at a blank/empty reply. On a successful publish_draft, your reply MUST state the real live URL verbatim — use the tool\'s `tell_mat_verbatim` ("Published — live at https://silkvelvetrecords.com/notes/<slug>/"). NEVER a bare "done"/"published"/"closed"; the checkable URL is the confirmation.';

  // Prompt caching (P1-5): the STABLE prefix (L1 identity + L2 facts + L3 skills) is
  // identical across turns of a task → mark it cache_control:ephemeral so Anthropic
  // caches it and only the DYNAMIC tail (session state + open loops + memory + ledger +
  // rules) is re-read each turn. The session block leads the dynamic tail so it stays
  // prominent (always-present, right after the cached prefix), never budget-dropped.
  // Current time — leads the dynamic tail so Silk never guesses the date. Injected per
  // message (dynamic, uncached). Fixes past/future, "how long ago", freshness, and
  // schedule-vs-now reasoning (e.g. a next_attempt_at timestamp).
  const now = new Date();
  const nowBlock = `\n\n--- CURRENT TIME ---\nNow: ${now.toISOString()} (UTC). Anchor every date/time judgement to this — is X past or future, how long ago, how stale, has a scheduled time passed. Never guess the current date or time.`;
  // Resolution + open loops lead the dynamic tail (highest priority for the turn), then now/session/etc.
  const dynamicText = pinnedBlock + resolutionBlock + openLoopsBlock + nowBlock + sessionLog + built.dynamic + operatingRules;
  const system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> = [
    { type: 'text', text: built.stable, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicText },
  ];
  const sourcingSystem = [
    system[0],
    { type: 'text' as const, text: dynamicText + '\n\n--- SOURCING GATE (enforced) ---\nYou just asked Mat for data you can fetch yourself. Use the appropriate tool (web_fetch / spotify_* / read_config_file / ledger_query_* / journal_retrieve) NOW and answer from the result. Only ask Mat if the tool genuinely fails.' },
  ];

  // Chat continuity: load the prior turns so Silk remembers the conversation (the
  // client already persisted the current user message before calling us). Without this
  // Silk answers every message in isolation.
  let history: { role: string; content: any }[] = [];
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

  // Image attachments (Claude is multimodal): attach to the FINAL user turn as image
  // content blocks. The bridge for login-walled data with no API — e.g. a Spotify for
  // Artists screenshot Silk reads the numbers off of. Not persisted to history (read once).
  const images = Array.isArray((body as any).images)
    ? (body as any).images
        .filter((im: any) => im?.data && /^image\/(png|jpe?g|gif|webp)$/.test(im?.media_type ?? ''))
        .slice(0, 4)
    : [];
  if (images.length) {
    for (let k = history.length - 1; k >= 0; k--) {
      if (history[k].role === 'user') {
        history[k].content = [
          { type: 'text', text: String(history[k].content ?? '') || 'Read the numbers in this image.' },
          ...images.map((im: any) => ({ type: 'image', source: { type: 'base64', media_type: im.media_type === 'image/jpg' ? 'image/jpeg' : im.media_type, data: im.data } })),
        ];
        break;
      }
    }
  }

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
            system: sourcingSystem,
            history, model, anthropicKey: ANTHROPIC_API_KEY, callerJwt: jwt, maxTokens: built.maxTokens,
          });
          if (fix.text && usedFetchTool(fix.toolTrace)) { text = fix.text; toolTrace = [...toolTrace, ...fix.toolTrace]; }
        }
        // P1-4 VERIFY-BEFORE-DONE gate: soften unbacked state-change claims.
        const vbd = verifyBeforeDone(text, toolTrace);
        if (vbd.softened) await admin.from('silk_journal').insert({ entry: `[gate] Softened an unverified state-change claim in chat (no confirmation tool ran this turn).`, tags: ['gate', 'verify-before-done'] });
        full = vbd.text;
        // P2-6 SELF-VERIFICATION: cheap second model audits factual claims about the
        // artist/label/metrics against the tool evidence; hedges any it can't source.
        if (shouldSelfVerify(full, toolTrace)) {
          const sv = await selfVerify(full, toolTrace, ANTHROPIC_API_KEY);
          if (sv.softened) {
            full = sv.text;
            await admin.from('silk_journal').insert({ entry: `[gate] Self-verification hedged ${sv.unsupported.length} unsupported factual claim(s): ${sv.unsupported.map((s) => s.slice(0, 80)).join(' | ')}`, tags: ['gate', 'self-verify'] });
          }
        }
        // P1-4 FORMAT gate: long / §-referencing replies → decision-first reformat (cheap model).
        if (needsReformat(full)) {
          full = await reformat(full, ANTHROPIC_API_KEY, (await loadConfig('skill:format-for-human')).value);
        }
        // Never ship an empty reply (heavy agent loops can exhaust their turn budget).
        if (!full.trim()) full = "I ran long on that one and didn't finish cleanly — ask me for one specific piece and I'll nail it.";

        // Deterministic publish confirmation (not prompt-dependent): a successful publish_draft
        // MUST surface its real live URL in the reply, however terse the model was. Append if missing.
        const pubT = toolTrace.find((t) => t.name === 'publish_draft' && (t.result as any)?.ok && (t.result as any)?.live_url);
        if (pubT) {
          const purl = (pubT.result as any).live_url as string;
          if (purl && !full.includes(purl)) full = full.replace(/\s*$/, '') + `\n\n**Published — live at ${purl}** — CI builds it live in ~1–2 min.`;
        }

        let filedThisTurn = false;
        if (toolTrace.length) {
          sse(controller, 'tools', { used: toolTrace.map((t) => t.name) });
          // Session log (P0-1): current-session truth, append-only — never from retrieval.
          for (const t of toolTrace) {
            await admin.from('silk_session_events').insert({ session_id: sessionId, event_type: 'tool_call', description: `${t.name}(${JSON.stringify(t.input).slice(0, 120)})` });
            // Pin an open loop for anything Silk filed for approval.
            if (t.name === 'queue_for_approval' && (t.result as any)?.item_id) {
              openLoops.push({ type: 'approval', item_id: (t.result as any).item_id, description: (t.result as any).description ?? 'a proposed action', created_at: new Date().toISOString() });
              await admin.from('silk_session_events').insert({ session_id: sessionId, event_type: 'filing', description: (t.result as any).description, item_id: (t.result as any).item_id });
              filedThisTurn = true;
            }
          }
        }
        // P0-1 FIX: pin a CONVERSATIONAL open loop when Silk asks Mat a question directly
        // (no queue item). This is where most of Mat's short replies land — and where the
        // pin was missing. Skip if Silk just filed a queue item (that's the actionable loop)
        // or if this turn already resolved a loop.
        if (!filedThisTurn && !resolutionNote) {
          const asksMat = /\?\s*("[^"]*")?\s*$/.test(full.trim())
            || /\b(should I|do you want me to|want me to|shall I|which (one|of|do)|would you (like|prefer)|prefer .* or |, or |confirm\?|right\?|ok\?)\b/i.test(full);
          if (asksMat) {
            // Pin the question WITH its context (up to ~350 chars before the final "?"),
            // so the loop carries the SUBJECT ("lock Hate Fuck as flagship — is that correct?"),
            // not a bare "Is that correct?" that leaves Silk hunting for what it meant.
            const tail = full.trim();
            const qEnd = tail.lastIndexOf('?');
            const q = (qEnd >= 0 ? tail.slice(Math.max(0, qEnd - 350), qEnd + 1) : tail.slice(-300)).trim();
            openLoops.push({ type: 'question', description: q, created_at: new Date().toISOString() });
            await admin.from('silk_session_events').insert({ session_id: sessionId, event_type: 'question', description: q.slice(0, 200) });
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
