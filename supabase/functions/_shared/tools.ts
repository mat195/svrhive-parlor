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
    name: 'spotify_artist_catalog',
    description: "Enumerate an artist's FULL Spotify catalog — every album, single, and appears_on release (paginated). Returns per release: title, date, LPT role (primary vs featured), collaborators, ISRC. Use for catalog audits / label backfills instead of asking Mat. Defaults to Lucius P. Thundercat.",
    input_schema: { type: 'object', properties: { artist_id: { type: 'string', description: 'Spotify artist id (default LPT)' } } },
  },
  {
    name: 'spotify_track_details',
    description: 'Full metadata for a specific track — including copyright + label (fetched from the track and its album). Accepts a Spotify track id or a "title artist" query. Returns ISRC, release date, label, copyrights, duration, popularity, URL.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'track id OR "title artist"' } }, required: ['query'] },
  },
  {
    name: 'read_config_file',
    description: "Read the ACTUAL current contents of an allowlisted repo config/rulebook file (ground truth). Use this to VERIFY before claiming any config is 'locked'/'set' — never assert config state from memory. Allowed: scripts/prompts.json, docs/LUCIUS_ENTITY_MASTER.md, skills/SILK_IDENTITY.md, skills/<name>.md.",
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'e.g. scripts/prompts.json' } }, required: ['path'] },
  },
  {
    name: 'get_action_queue_item',
    description: 'Fetch one action_queue item by its exact id (not fuzzy). Use when you have a queue-item id and need its full payload/status.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'get_ledger_record',
    description: 'Fetch one row by id from a ledger table (Layer 5 fetch-by-id). Allowed tables: action_queue, silk_journal, mat_answers, corpus_drafts, visibility_runs, silk_questions, chat_extractions.',
    input_schema: { type: 'object', properties: { table: { type: 'string' }, id: { type: 'string' } }, required: ['table', 'id'] },
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

async function spotifyTrackDetails(query: string): Promise<unknown> {
  const token = await spotifyToken();
  if (!token) return { error: 'spotify credentials unavailable' };
  const H = { Authorization: `Bearer ${token}` };
  // Resolve to a track id: use as id if it looks like one, else search.
  let id = /^[A-Za-z0-9]{22}$/.test(query.trim()) ? query.trim() : null;
  if (!id) {
    const s = await (await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`, { headers: H })).json();
    id = s?.tracks?.items?.[0]?.id ?? null;
    if (!id) return { error: 'no track found for query' };
  }
  const t = await (await fetch(`https://api.spotify.com/v1/tracks/${id}`, { headers: H })).json();
  if (t.error) return { error: `spotify track ${t.error.status}` };
  // label + copyrights live on the album object.
  let label = null, copyrights = null;
  if (t.album?.id) {
    const al = await (await fetch(`https://api.spotify.com/v1/albums/${t.album.id}`, { headers: H })).json();
    label = al.label ?? null;
    copyrights = (al.copyrights ?? []).map((c: any) => `${c.type}: ${c.text}`);
  }
  return {
    name: t.name, artists: (t.artists ?? []).map((a: any) => a.name).join(', '),
    isrc: t.external_ids?.isrc ?? null, album: t.album?.name, release_date: t.album?.release_date,
    label, copyrights, duration_ms: t.duration_ms, popularity: t.popularity, url: t.external_urls?.spotify,
  };
}

const LPT_ARTIST = '2lhuyLLQPcfoXSwcNaXuF1';
async function spotifyArtistCatalog(artistId: string): Promise<unknown> {
  const token = await spotifyToken();
  if (!token) return { error: 'spotify credentials unavailable' };
  const H = { Authorization: `Bearer ${token}` };
  const seen = new Map<string, any>();
  for (const grp of ['album', 'single', 'appears_on']) {
    let off = 0;
    while (true) {
      const j = await (await fetch(`https://api.spotify.com/v1/artists/${artistId}/albums?include_groups=${grp}&market=US&limit=10&offset=${off}`, { headers: H })).json();
      if (j.error) break;
      for (const a of j.items ?? []) if (!seen.has(a.id)) seen.set(a.id, a);
      if (!j.items || j.items.length < 10) break;
      off += 10;
    }
  }
  const out: unknown[] = [];
  for (const a of seen.values()) {
    let isrc = null;
    try {
      const tj = await (await fetch(`https://api.spotify.com/v1/albums/${a.id}/tracks?market=US&limit=1`, { headers: H })).json();
      const first = (tj.items ?? [])[0];
      if (first) { const t = await (await fetch(`https://api.spotify.com/v1/tracks/${first.id}`, { headers: H })).json(); isrc = t.external_ids?.isrc ?? null; }
    } catch { /* isrc best-effort */ }
    out.push({
      title: a.name, date: a.release_date, album_group: a.album_group ?? a.album_type,
      role: (a.artists ?? []).some((x: any) => x.id === artistId) ? 'primary' : 'featured',
      collaborators: (a.artists ?? []).map((x: any) => x.name), isrc,
    });
  }
  return { count: out.length, releases: out };
}

// Map an allowlisted repo path → its silk_config key (files are synced there).
function configKeyForPath(path: string): string | null {
  const p = path.trim().replace(/^\.?\//, '');
  if (p === 'skills/SILK_IDENTITY.md') return 'silk_identity';
  if (p === 'docs/LUCIUS_ENTITY_MASTER.md') return 'entity_master';
  if (p === 'skills/conversation-distillation.md') return 'distill_doctrine';
  const skill = p.match(/^skills\/([\w-]+)\.md$/);
  if (skill) return `skill:${skill[1]}`;
  if (/^(scripts|config)\//.test(p) && !p.includes('..')) return `file:${p}`;
  return null;
}
async function readConfigFile(path: string): Promise<unknown> {
  const key = configKeyForPath(path);
  if (!key) return { error: `path not allowlisted: ${path}` };
  const { data } = await admin.from('silk_config').select('value, hash, updated_at').eq('key', key).maybeSingle();
  if (!data) return { error: `not synced: ${path} (key ${key})` };
  return { path, hash: data.hash, updated_at: data.updated_at, content: String(data.value).slice(0, 12000) };
}

const FETCH_TABLES = new Set(['action_queue', 'silk_journal', 'mat_answers', 'corpus_drafts', 'visibility_runs', 'silk_questions', 'chat_extractions']);
async function getRecord(table: string, id: string): Promise<unknown> {
  if (!FETCH_TABLES.has(table)) return { error: `table not allowed: ${table}` };
  const { data, error } = await admin.from(table).select('*').eq('id', id).maybeSingle();
  if (error) return { error: error.message };
  return data ?? { error: 'not found' };
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
    if (name === 'spotify_artist_catalog') return await spotifyArtistCatalog(String(input.artist_id ?? LPT_ARTIST));
    if (name === 'spotify_track_details') return await spotifyTrackDetails(String(input.query ?? ''));
    if (name === 'read_config_file') return await readConfigFile(String(input.path ?? ''));
    if (name === 'get_action_queue_item') return await getRecord('action_queue', String(input.id ?? ''));
    if (name === 'get_ledger_record') return await getRecord(String(input.table ?? ''), String(input.id ?? ''));
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
