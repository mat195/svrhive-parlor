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
import { SILK_IDENTITY } from './identity.ts';

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

function loadIdentity(): string {
  return SILK_IDENTITY;
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

  // /deep flag → stronger model
  const deep = body.deep === true || /^\/deep\b/i.test(rawMessage);
  const message = rawMessage.replace(/^\/deep\b\s*/i, '');
  const model = deep ? DEEP_MODEL : CHEAP_MODEL;

  const identity = loadIdentity();
  const { ctx, refs } = await gatherContext(message);

  const system =
    identity +
    '\n\n--- OPERATING RULES (Parlor) ---\n' +
    'You are grounded in the SVRHIVE ledger context below. Answer ONLY from it plus general knowledge that does not assert facts about Lucius P. Thundercat / Silk Velvet Records.\n' +
    'PROVENANCE: if the ledger does not contain the answer, say so plainly — do not invent. Never fabricate metrics, mentions, or facts about the artist/label.\n' +
    'Canonical name is always "Lucius P. Thundercat", never abbreviated. Lead with the number. Be concise.\n\n' +
    '--- LEDGER CONTEXT ---\n' + ctx;

  const stream = new ReadableStream({
    async start(controller) {
      sse(controller, 'refs', { ledger_refs: refs, model });
      let full = '';
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            model,
            max_tokens: MAX_TOKENS,
            system,
            stream: true,
            messages: [{ role: 'user', content: message }],
          }),
        });
        if (!res.ok || !res.body) {
          sse(controller, 'delta', { text: `\n[silk-chat error: ${res.status}]` });
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() ?? '';
            for (const line of lines) {
              const m = line.match(/^data: (.*)$/);
              if (!m) continue;
              try {
                const evt = JSON.parse(m[1]);
                if (evt.type === 'content_block_delta' && evt.delta?.text) {
                  full += evt.delta.text;
                  sse(controller, 'delta', { text: evt.delta.text });
                }
              } catch { /* ignore keep-alives */ }
            }
          }
        }
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
      sse(controller, 'done', { ok: true });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
});
