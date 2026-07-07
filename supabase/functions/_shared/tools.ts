// Silk tool-use (Anthropic tools + multi-turn loop). Every Silk-invoking Edge
// Function runs its Anthropic call through runToolLoop so Claude can fetch public
// data, query the ledger, and read semantic memory MID-RESPONSE instead of asking
// Mat for data the tools could retrieve.
//
// Tools: web_fetch (public data), journal_retrieve (Layer 4 memory),
// ledger_query_* (Layer 5 observations). All read-only.
import { admin } from './auth.ts';
import { retrieve } from './journal.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

export const SILK_TOOLS = [
  {
    name: 'web_fetch',
    description: 'GET a public web page (allowlisted music/entity domains only: Spotify, SoundCloud, Bandcamp, Apple Music, MusicBrainz, Wikidata, etc.). Use this to retrieve real public data — release metadata, artist pages, credits — instead of asking Mat. Returns status + page body.',
    input_schema: { type: 'object', properties: { url: { type: 'string', description: 'Full https URL on an allowlisted domain' } }, required: ['url'] },
  },
  {
    name: 'spotify_lookup',
    description: 'Search the Spotify catalog for a track/album/artist and return REAL metadata (title, artists, album, release date, popularity, URL). Use this for any specific song/release question instead of asking Mat. Query like: track name artist name.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'e.g. "Love You/Leave You Nick Nigh"' }, type: { type: 'string', description: 'track | album | artist (default track)' } }, required: ['query'] },
  },
  {
    name: 'journal_retrieve',
    description: "Semantic search over Silk's own journal + past answers (Layer 4 memory). Use when you need a past lesson, decision, or fact you may have recorded but cannot see in context.",
    input_schema: { type: 'object', properties: { query: { type: 'string' }, top_n: { type: 'number' } }, required: ['query'] },
  },
  {
    name: 'ledger_query_battery',
    description: 'Query recent visibility battery runs (scores, mention counts). Layer 5 observability.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'ledger_query_mentions',
    description: 'Query recent per-prompt visibility results (which engine mentioned LPT for which query). Layer 5.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'ledger_query_drafts',
    description: 'Query corpus drafts (proposed/published pages). Layer 5.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'ledger_query_web_fetches',
    description: 'Query the web-fetch cache (what Silk has already fetched). Layer 5.',
    input_schema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
];

let _spotifyToken: { token: string; exp: number } | null = null;
async function spotifyToken(): Promise<string | null> {
  const id = Deno.env.get('SPOTIFY_CLIENT_ID'), secret = Deno.env.get('SPOTIFY_CLIENT_SECRET');
  if (!id || !secret) return null;
  if (_spotifyToken && Date.now() < _spotifyToken.exp) return _spotifyToken.token;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${id}:${secret}`) },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) return null;
  const j = await res.json();
  _spotifyToken = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 - 60_000 };
  return _spotifyToken.token;
}

async function spotifyLookup(query: string, type: string): Promise<unknown> {
  const token = await spotifyToken();
  if (!token) return { error: 'spotify credentials unavailable' };
  const t = ['track', 'album', 'artist'].includes(type) ? type : 'track';
  const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=${t}&limit=5`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return { error: `spotify search ${res.status}` };
  const j = await res.json();
  const items = j?.[`${t}s`]?.items ?? [];
  return items.slice(0, 5).map((it: any) => ({
    name: it.name,
    artists: (it.artists ?? []).map((a: any) => a.name).join(', '),
    album: it.album?.name,
    release_date: it.album?.release_date ?? it.release_date,
    popularity: it.popularity,
    url: it.external_urls?.spotify,
  }));
}

async function ledger(table: string, cols: string, limit: number) {
  try {
    const { data } = await admin.from(table).select(cols).order('created_at', { ascending: false }).limit(limit);
    return data ?? [];
  } catch { return []; }
}

async function executeTool(name: string, input: Record<string, unknown>, callerJwt: string): Promise<unknown> {
  try {
    if (name === 'web_fetch') {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/web-fetch`, {
        method: 'POST',
        headers: { apikey: ANON_KEY, Authorization: `Bearer ${callerJwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: input.url }),
      });
      const j = await res.json();
      if (!res.ok) return { error: j.error ?? `web-fetch ${res.status}`, allowlist: j.allowlist };
      return { url: j.url, status: j.status, from_cache: j.from_cache, body: String(j.body ?? '').slice(0, 6000) };
    }
    if (name === 'spotify_lookup') return await spotifyLookup(String(input.query ?? ''), String(input.type ?? 'track'));
    if (name === 'journal_retrieve') {
      const out = await retrieve(String(input.query ?? ''), Number(input.top_n ?? 5), 3);
      return [...out.relevant, ...out.recent].slice(0, 8).map((e) => ({ entry: e.entry, tags: e.tags, at: e.created_at }));
    }
    const limit = Math.min(20, Number(input.limit ?? 8));
    if (name === 'ledger_query_battery') return await ledger('visibility_runs', 'id, run_at, prompt_count, mentions_total, label_mentions_total', limit);
    if (name === 'ledger_query_mentions') return await ledger('visibility_results', 'engine, category, prompt, mentioned, response_excerpt', limit);
    if (name === 'ledger_query_drafts') return await ledger('corpus_drafts', 'target_query, status, filename, live_url', limit);
    if (name === 'ledger_query_web_fetches') return await ledger('web_fetch_cache', 'url, status, fetched_at', limit);
    return { error: `unknown tool ${name}` };
  } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

export interface ToolLoopResult { text: string; toolTrace: { name: string; input: unknown }[]; turns: number; stopReason: string }

/**
 * Multi-turn Anthropic tool-use loop. Non-streaming (tool turns need full messages).
 * Returns the final assistant text once Claude stops requesting tools.
 */
export async function runToolLoop(opts: {
  system: string; userText: string; model: string; anthropicKey: string;
  callerJwt: string; maxTokens?: number; maxTurns?: number; tools?: typeof SILK_TOOLS;
}): Promise<ToolLoopResult> {
  const tools = opts.tools ?? SILK_TOOLS;
  const messages: { role: string; content: unknown }[] = [{ role: 'user', content: opts.userText }];
  const toolTrace: { name: string; input: unknown }[] = [];
  const maxTurns = opts.maxTurns ?? 5;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': opts.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? 1500, system: opts.system, tools, messages }),
    });
    const data = await res.json();
    if (!res.ok) return { text: `[silk tool-loop error ${res.status}: ${data?.error?.message ?? ''}]`, toolTrace, turns: turn, stopReason: 'error' };

    const blocks = data?.content ?? [];
    const textOut = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');

    if (data.stop_reason !== 'tool_use') return { text: textOut, toolTrace, turns: turn, stopReason: data.stop_reason ?? 'end_turn' };

    // Execute every requested tool, feed results back.
    messages.push({ role: 'assistant', content: blocks });
    const toolResults: unknown[] = [];
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue;
      toolTrace.push({ name: b.name, input: b.input });
      const result = await executeTool(b.name, b.input ?? {}, opts.callerJwt);
      toolResults.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(result).slice(0, 8000) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  // Ran out of turns — do one final no-tools call to force a text answer.
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': opts.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: opts.model, max_tokens: opts.maxTokens ?? 1500, system: opts.system, messages }),
  });
  const data = await res.json();
  const textOut = (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
  return { text: textOut, toolTrace, turns: maxTurns, stopReason: data?.stop_reason ?? 'max_turns' };
}
