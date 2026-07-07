// catalog-label-sweep (resumable worker) — sweeps LPT's primary catalog for the
// Silk Velvet Records label (Spotify album label + copyright). Survives Spotify's
// hard rate limits two ways: (1) a POOL of Spotify apps, each its own quota bucket —
// on 429 it rotates to the next app's token mid-run and keeps going; (2) only when
// EVERY app is rate-limited does it checkpoint next_attempt_at (to the SOONEST app
// reset) and return; a cron resumes it. When complete it journals the SVR split,
// files a §2 proposal, and pings Discord.
import { admin, json, CORS } from '../_shared/auth.ts';

const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
// Spotify app pool: primary + any fallback apps. Each is a separate client-credentials
// quota bucket, so when one is exhausted the next still serves. Add more by setting
// SPOTIFY_CLIENT_ID_3/SECRET_3, etc., and appending here.
const APPS = [
  { id: Deno.env.get('SPOTIFY_CLIENT_ID') ?? '', secret: Deno.env.get('SPOTIFY_CLIENT_SECRET') ?? '' },
  { id: Deno.env.get('SPOTIFY_CLIENT_ID_2') ?? '', secret: Deno.env.get('SPOTIFY_CLIENT_SECRET_2') ?? '' },
].filter((a) => a.id && a.secret);
const DISCORD = Deno.env.get('DISCORD_WEBHOOK_URL') ?? '';
const LPT = '2lhuyLLQPcfoXSwcNaXuF1';
const TASK = 'catalog-label-sweep';
const BATCH = 15;

type FetchResult = { data?: any; rateLimited?: boolean; retryAfter?: number };

async function appToken(app: { id: string; secret: string }): Promise<string | null> {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${app.id}:${app.secret}`) }, body: 'grant_type=client_credentials',
  });
  if (!r.ok) return null;
  return (await r.json()).access_token ?? null;
}

// Rotating client-credentials pool. fetch() tries each app not currently rate-limited;
// on 429 it marks that app busy-until-reset and rotates to the next. Only when all apps
// are busy does it surface rateLimited, with retryAfter = seconds until the SOONEST app
// frees (so the checkpoint waits no longer than necessary).
class SpotifyPool {
  private toks: (string | null | undefined)[];
  private busyUntil: number[]; // epoch ms each app is rate-limited until (0 = free)
  constructor(private apps: { id: string; secret: string }[]) {
    this.toks = apps.map(() => undefined);
    this.busyUntil = apps.map(() => 0);
  }
  get size() { return this.apps.length; }
  private async tok(i: number): Promise<string | null> {
    if (this.toks[i] === undefined) this.toks[i] = await appToken(this.apps[i]);
    return this.toks[i] ?? null;
  }
  private soonestFreeSecs(): number {
    const busy = this.busyUntil.filter((t) => t > 0);
    if (!busy.length) return 3600;
    return Math.max(1, Math.ceil((Math.min(...busy) - Date.now()) / 1000));
  }
  async fetch(url: string): Promise<FetchResult> {
    for (let i = 0; i < this.apps.length; i++) {
      if (this.busyUntil[i] > Date.now()) continue;      // known rate-limited → skip
      const t = await this.tok(i);
      if (!t) { this.busyUntil[i] = Date.now() + 3600_000; continue; } // auth fail → park an hour
      const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
      if (r.status === 429) {
        this.busyUntil[i] = Date.now() + parseInt(r.headers.get('retry-after') ?? '3600') * 1000;
        continue;                                        // rotate to the next app
      }
      try { return { data: await r.json() }; } catch { return {}; }
    }
    return { rateLimited: true, retryAfter: this.soonestFreeSecs() }; // every app exhausted
  }
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
  const pool = new SpotifyPool(APPS);
  if (!pool.size) return json({ error: 'no spotify apps configured' }, 502);

  // 1) Enumerate the primary catalog once.
  if (!state.enumerated) {
    const ids: string[] = []; const seen = new Set<string>();
    for (const grp of ['album', 'single']) {
      let off = 0;
      while (true) {
        const r = await pool.fetch(`https://api.spotify.com/v1/artists/${LPT}/albums?include_groups=${grp}&market=US&limit=10&offset=${off}`);
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
    const r = await pool.fetch(`https://api.spotify.com/v1/albums/${id}`);
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
