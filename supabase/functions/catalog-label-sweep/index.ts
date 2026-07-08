// catalog-label-sweep (resumable worker) — sweeps LPT's primary catalog for the
// Silk Velvet Records label (Spotify album label + copyright) on a SINGLE Spotify app.
//
// Rate-limit strategy (single-app):
//   1. BATCH to stay under the limit in the first place. Enumeration pages at limit=50;
//      album labels are fetched via /v1/albums?ids=... (20 IDs per call), not one call
//      per release. A ~55-release sweep is ~5 calls total, not ~60.
//   2. THROTTLE — a small delay between calls so a burst never trips the window.
//   3. BACKOFF + QUEUE (primary fallback) — if a 429 still hits, respect Spotify's
//      Retry-After header (else exponential backoff), checkpoint next_attempt_at, and
//      return; the hourly cron resumes from the checkpoint. Progress is never lost.
//
// When complete it journals the SVR split, files a §2 proposal, and pings Discord.
import { admin, json, CORS } from '../_shared/auth.ts';
import { fileQueueItem } from '../_shared/queue.ts';

const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const CID = Deno.env.get('SPOTIFY_CLIENT_ID') ?? '';
const CSEC = Deno.env.get('SPOTIFY_CLIENT_SECRET') ?? '';
const DISCORD = Deno.env.get('DISCORD_WEBHOOK_URL') ?? '';
const LPT = '2lhuyLLQPcfoXSwcNaXuF1';
const TASK = 'catalog-label-sweep';
const ALBUM_IDS_PER_CALL = 20;   // Spotify /v1/albums?ids= cap
const MAX_BATCHES = 6;           // 6×20 = 120 albums/invocation — covers the whole catalog
const THROTTLE_MS = 250;         // gentle spacing between calls

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  if (r.status === 429) {
    const ra = r.headers.get('retry-after');
    return { rateLimited: true, retryAfter: ra ? parseInt(ra) : undefined }; // undefined → exponential
  }
  try { return { data: await r.json() }; } catch { return {}; }
}

// Compute + store the next resume time. Respect Retry-After when present; otherwise back
// off exponentially (30s, 60s, 120s, … capped at 1h) using a persisted attempt counter.
function scheduleRetry(state: any, retryAfter?: number): string {
  const wait = retryAfter ?? Math.min(3600, 30 * 2 ** (state.backoff ?? 0));
  state.backoff = (state.backoff ?? 0) + 1;
  state.next_attempt_at = new Date(Date.now() + (wait + 5) * 1000).toISOString();
  return state.next_attempt_at;
}

async function loadCp() {
  const { data } = await admin.from('silk_task_checkpoints').select('*').eq('task', TASK).neq('status', 'done').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (data) return data;
  const { data: created } = await admin.from('silk_task_checkpoints').insert({ task: TASK, status: 'running', state: { enumerated: false, album_ids: [], results: {}, next_attempt_at: null, backoff: 0 } }).select('*').single();
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

  // 1) Enumerate the primary catalog once — page at limit=50 (5× fewer pages than limit=10).
  if (!state.enumerated) {
    const ids: string[] = []; const seen = new Set<string>();
    for (const grp of ['album', 'single']) {
      let off = 0;
      while (true) {
        const r = await sfetch(`https://api.spotify.com/v1/artists/${LPT}/albums?include_groups=${grp}&market=US&limit=50&offset=${off}`, tok);
        if (r.rateLimited) { const until = scheduleRetry(state, r.retryAfter); await save(cp.id, state, { note: 'rate-limited during enumeration' }); return json({ ok: true, waiting: true, until }); }
        const items = r.data?.items ?? [];
        for (const a of items) if (!seen.has(a.id) && (a.artists ?? []).some((x: any) => x.id === LPT)) { seen.add(a.id); ids.push(a.id); }
        if (items.length < 50) break; off += 50;
        await sleep(THROTTLE_MS);
      }
    }
    state.album_ids = ids; state.enumerated = true; state.backoff = 0; state.next_attempt_at = null;
    await save(cp.id, state);
  }

  // 2) Fetch album labels in BATCHES of 20 via /v1/albums?ids=... (not one call per album).
  //    Results are keyed by the requested id (response order matches request order, null =
  //    missing) so every id resolves and `remaining` always converges.
  const todo = (state.album_ids as string[]).filter((id) => !state.results[id]);
  let processed = 0;
  for (let b = 0; b < MAX_BATCHES && processed < todo.length; b++) {
    const chunk = todo.slice(processed, processed + ALBUM_IDS_PER_CALL);
    const r = await sfetch(`https://api.spotify.com/v1/albums?ids=${chunk.join(',')}&market=US`, tok);
    if (r.rateLimited) { const until = scheduleRetry(state, r.retryAfter); await save(cp.id, state, { note: `rate-limited; ${todo.length - processed} albums left` }); return json({ ok: true, waiting: true, until, remaining: todo.length - processed }); }
    const albums = r.data?.albums ?? [];
    chunk.forEach((id, i) => {
      const al = albums[i];
      if (!al?.id) { state.results[id] = { missing: true, svr: false }; return; }
      const cr = (al.copyrights ?? []).map((c: any) => c.text).join(' | ');
      state.results[id] = { title: al.name, date: al.release_date, label: al.label ?? null, cr, svr: /silk\s*velvet/i.test(`${al.label ?? ''} ${cr}`) };
    });
    processed += chunk.length;
    await sleep(THROTTLE_MS);
  }
  state.backoff = 0; state.next_attempt_at = null;
  await save(cp.id, state);

  const remaining = (state.album_ids as string[]).filter((id) => !state.results[id]).length;
  if (remaining > 0) return json({ ok: true, done: false, processed, remaining });

  // 3) Complete — compile, journal, propose §2 update, ping Discord.
  const res = (Object.values(state.results) as any[]).filter((r) => !r.missing);
  const yes = res.filter((r) => r.svr).sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  const no = res.filter((r) => !r.svr);

  // DEGENERATE GUARD: 0 albums enumerated is not a finding — it means enumeration
  // returned nothing (Spotify rate limit / stale catalog approach), not "0 of 0 pass".
  // Do NOT file a 0/0 metadata-fix; journal it and throttle 24h so the hourly cron
  // stops re-running (keep status 'running' + a day-out next_attempt_at → gate skips).
  if (res.length === 0) {
    state.next_attempt_at = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await save(cp.id, state, { note: 'enumerated 0 albums — degenerate, not filing; throttled 24h' });
    await admin.from('silk_journal').insert({ entry: '[label-sweep] enumerated 0 albums (rate-limited or catalog approach stale) — skipped filing a 0/0 §2 metadata-fix; throttled 24h.', tags: ['label-sweep', 'degenerate', 'skipped'] });
    return json({ ok: true, degenerate: true, note: 'enumerated 0; not filed; throttled 24h' });
  }

  await admin.from('silk_task_checkpoints').update({ status: 'done', note: `${res.length} releases · ${yes.length} SVR`, updated_at: new Date().toISOString() }).eq('id', cp.id);
  await admin.from('entity_facts').insert({ key: '§2 label association (Spotify sweep)', value: `${yes.length}/${res.length} primary releases carry Silk Velvet Records in label/copyright (e.g. ${yes.slice(0, 5).map((r) => r.title).join(', ')})`, source: 'Spotify catalog label sweep', confidence: 'verified' });
  await admin.from('silk_journal').insert({ entry: `Catalog label sweep complete: ${yes.length}/${res.length} primary releases show Silk Velvet Records (label or © line). SVR: ${yes.map((r) => r.title).join(', ')}. This contradicts §2's "no public association found" — the association is already live on ${yes.length} releases.`, tags: ['catalog', 'label-sweep', 'svr', 'finding'] });
  const filed = await fileQueueItem({ kind: 'metadata-fix', risk_tier: 'amber', maxPerDay: 1, payload: { title: `§2 label: ${yes.length}/${res.length} releases already show Silk Velvet Records`, generated_by: 'label-sweep', rationale: `Spotify sweep: ${yes.length} of ${res.length} primary releases carry Silk Velvet Records in label/copyright. Update §2 (currently "no public association found") to reflect the confirmed association. Releases: ${yes.map((r) => `${r.title} (${r.date})`).join('; ')}.`, svr_releases: yes.map((r) => ({ title: r.title, date: r.date, label: r.label, copyright: r.cr })), non_svr_count: no.length } });
  if (DISCORD && filed.filed) await fetch(DISCORD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🏷️ **Catalog label sweep done** — ${yes.length}/${res.length} of LPT's primary releases already show **Silk Velvet Records**. A §2-update proposal is waiting in your Workshop queue. — Silk` }) }).catch(() => {});

  return json({ ok: true, done: true, total: res.length, svr: yes.length, svr_titles: yes.map((r) => r.title), filed });
});
