// catalog-label-sweep (resumable worker) — sweeps LPT's primary catalog for the
// Silk Velvet Records label (Spotify album label + copyright). Survives Spotify's
// hard rate limits: on 429 it stores the Retry-After as next_attempt_at, checkpoints
// progress, and returns; a cron re-runs it and it resumes from the checkpoint. When
// complete it journals the SVR split, files a §2 proposal, and pings Discord.
import { admin, json, CORS } from '../_shared/auth.ts';

const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const CID = Deno.env.get('SPOTIFY_CLIENT_ID') ?? '';
const CSEC = Deno.env.get('SPOTIFY_CLIENT_SECRET') ?? '';
const DISCORD = Deno.env.get('DISCORD_WEBHOOK_URL') ?? '';
const LPT = '2lhuyLLQPcfoXSwcNaXuF1';
const TASK = 'catalog-label-sweep';
const BATCH = 15;

async function token(): Promise<string | null> {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${CID}:${CSEC}`) }, body: 'grant_type=client_credentials',
  });
  if (!r.ok) return null;
  return (await r.json()).access_token ?? null;
}
type FetchResult = { data?: any; rateLimited?: boolean; retryAfter?: number };
async function sfetch(url: string, tok: string): Promise<FetchResult> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (r.status === 429) return { rateLimited: true, retryAfter: parseInt(r.headers.get('retry-after') ?? '3600') };
  try { return { data: await r.json() }; } catch { return {}; }
}

async function loadCp() {
  const { data } = await admin.from('silk_task_checkpoints').select('*').eq('task', TASK).neq('status', 'done').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (data) return data;
  const { data: created } = await admin.from('silk_task_checkpoints').insert({ task: TASK, status: 'running', state: { enumerated: false, album_ids: [], results: {}, next_attempt_at: null } }).select('*').single();
  return created;
}
const save = (id: string, state: any, extra: Record<string, unknown> = {}) => admin.from('silk_task_checkpoints').update({ state, updated_at: new Date().toISOString(), ...extra }).eq('id', id);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!CRON_KEY || req.headers.get('x-cron-key') !== CRON_KEY) return json({ error: 'unauthorized' }, 401);

  const cp = await loadCp();
  const state = cp.state as any;
  if (state.next_attempt_at && Date.now() < Date.parse(state.next_attempt_at)) {
    return json({ ok: true, waiting: true, until: state.next_attempt_at });
  }
  const tok = await token();
  if (!tok) return json({ error: 'spotify auth failed' }, 502);

  // 1) Enumerate the primary catalog once.
  if (!state.enumerated) {
    const ids: string[] = []; const seen = new Set<string>();
    for (const grp of ['album', 'single']) {
      let off = 0;
      while (true) {
        const r = await sfetch(`https://api.spotify.com/v1/artists/${LPT}/albums?include_groups=${grp}&market=US&limit=10&offset=${off}`, tok);
        if (r.rateLimited) { state.next_attempt_at = new Date(Date.now() + (r.retryAfter! + 5) * 1000).toISOString(); await save(cp.id, state, { note: 'rate-limited during enumeration' }); return json({ ok: true, waiting: true, until: state.next_attempt_at }); }
        const items = r.data?.items ?? [];
        for (const a of items) if (!seen.has(a.id) && (a.artists ?? []).some((x: any) => x.id === LPT)) { seen.add(a.id); ids.push(a.id); }
        if (items.length < 10) break; off += 10;
      }
    }
    state.album_ids = ids; state.enumerated = true; state.next_attempt_at = null;
    await save(cp.id, state);
  }

  // 2) Fetch album labels in a bounded batch; checkpoint on rate limit.
  const todo = (state.album_ids as string[]).filter((id) => !state.results[id]);
  let processed = 0;
  for (const id of todo) {
    if (processed >= BATCH) break;
    const r = await sfetch(`https://api.spotify.com/v1/albums/${id}`, tok);
    if (r.rateLimited) { state.next_attempt_at = new Date(Date.now() + (r.retryAfter! + 5) * 1000).toISOString(); await save(cp.id, state, { note: `rate-limited; ${todo.length - processed} albums left` }); return json({ ok: true, waiting: true, until: state.next_attempt_at, remaining: todo.length - processed }); }
    const al = r.data ?? {};
    const cr = (al.copyrights ?? []).map((c: any) => c.text).join(' | ');
    state.results[id] = { title: al.name, date: al.release_date, label: al.label ?? null, cr, svr: /silk\s*velvet/i.test(`${al.label ?? ''} ${cr}`) };
    processed++;
  }
  state.next_attempt_at = null;
  await save(cp.id, state);

  const remaining = (state.album_ids as string[]).filter((id) => !state.results[id]).length;
  if (remaining > 0) return json({ ok: true, done: false, processed, remaining });

  // 3) Complete — compile, journal, propose §2 update, ping Discord.
  const res = Object.values(state.results) as any[];
  const yes = res.filter((r) => r.svr).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const no = res.filter((r) => !r.svr);
  await admin.from('silk_task_checkpoints').update({ status: 'done', note: `${res.length} releases · ${yes.length} SVR`, updated_at: new Date().toISOString() }).eq('id', cp.id);
  await admin.from('entity_facts').insert({ key: '§2 label association (Spotify sweep)', value: `${yes.length}/${res.length} primary releases carry Silk Velvet Records in label/copyright (e.g. ${yes.slice(0, 5).map((r) => r.title).join(', ')})`, source: 'Spotify catalog label sweep', confidence: 'verified' });
  await admin.from('silk_journal').insert({ entry: `Catalog label sweep complete: ${yes.length}/${res.length} primary releases show Silk Velvet Records (label or © line). SVR: ${yes.map((r) => r.title).join(', ')}. This contradicts §2's "no public association found" — the association is already live on ${yes.length} releases.`, tags: ['catalog', 'label-sweep', 'svr', 'finding'] });
  await admin.from('action_queue').insert({ kind: 'metadata-fix', status: 'proposed', risk_tier: 'amber', payload: { title: `§2 label: ${yes.length}/${res.length} releases already show Silk Velvet Records`, generated_by: 'label-sweep', rationale: `Spotify sweep: ${yes.length} of ${res.length} primary releases carry Silk Velvet Records in label/copyright. Update §2 (currently "no public association found") to reflect the confirmed association. Releases: ${yes.map((r) => `${r.title} (${r.date})`).join('; ')}.`, svr_releases: yes.map((r) => ({ title: r.title, date: r.date, label: r.label, copyright: r.cr })), non_svr_count: no.length } });
  if (DISCORD) await fetch(DISCORD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🏷️ **Catalog label sweep done** — ${yes.length}/${res.length} of LPT's primary releases already show **Silk Velvet Records**. A §2-update proposal is waiting in your Workshop queue. — Silk` }) }).catch(() => {});

  return json({ ok: true, done: true, total: res.length, svr: yes.length, svr_titles: yes.map((r) => r.title) });
});
