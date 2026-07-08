// catalog-label-sweep (resumable) — the REAL label-data source for the §2 "does this
// release carry Silk Velvet Records as its label" question. Instead of the old fragile
// artist-album ENUMERATION (which returned 0), it resolves each release's Spotify album
// directly from the DB's own UPC/ISRC (targeted lookups), reads album.label + copyrights,
// and PERSISTS them onto releases.label/copyright. The §2 finding is then computed from
// the DB — real numbers, durable, queryable. Resumable + rate-limit safe (checkpoint).
import { admin, json, CORS } from '../_shared/auth.ts';
import { fileQueueItem } from '../_shared/queue.ts';

const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const CID = Deno.env.get('SPOTIFY_CLIENT_ID') ?? '';
const CSEC = Deno.env.get('SPOTIFY_CLIENT_SECRET') ?? '';
const DISCORD = Deno.env.get('DISCORD_WEBHOOK_URL') ?? '';
const TASK = 'catalog-label-sweep';
const PER_RUN = 12;        // releases resolved per invocation (~3 Spotify calls each)
const THROTTLE_MS = 200;

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
  if (r.status === 429) { const ra = r.headers.get('retry-after'); return { rateLimited: true, retryAfter: ra ? parseInt(ra) : undefined }; }
  try { return { data: await r.json() }; } catch { return {}; }
}

function scheduleRetry(state: any, retryAfter?: number): string {
  const wait = retryAfter ?? Math.min(3600, 30 * 2 ** (state.backoff ?? 0));
  state.backoff = (state.backoff ?? 0) + 1;
  state.next_attempt_at = new Date(Date.now() + (wait + 5) * 1000).toISOString();
  return state.next_attempt_at;
}

async function loadCp() {
  const { data } = await admin.from('silk_task_checkpoints').select('*').eq('task', TASK).neq('status', 'done').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (data) return data;
  const { data: created } = await admin.from('silk_task_checkpoints').insert({ task: TASK, status: 'running', state: { next_attempt_at: null, backoff: 0 } }).select('*').single();
  return created;
}
const save = (id: string, state: any, extra: Record<string, unknown> = {}) => admin.from('silk_task_checkpoints').update({ state, updated_at: new Date().toISOString(), ...extra }).eq('id', id);

const SVR = /silk\s*velvet/i;

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

  // Work queue = tier-1 releases not yet label-checked. Progress is tracked by
  // label_checked_at on each row (no separate checkpoint list needed) → naturally resumable.
  const { data: todo } = await admin.from('releases')
    .select('id, title, upc, tracks(isrc)')
    .is('label_checked_at', null).eq('tier', 1).limit(PER_RUN * 4);

  let processed = 0;
  for (const r of (todo ?? []) as any[]) {
    if (processed >= PER_RUN) break;
    const upc = r.upc as string | null;
    const isrc = r.tracks?.[0]?.isrc as string | undefined;

    // 1) resolve Spotify album id — by UPC (album) first, else ISRC (track → album)
    let albumId: string | null = null;
    if (upc) {
      const s = await sfetch(`https://api.spotify.com/v1/search?q=upc:${encodeURIComponent(upc)}&type=album&limit=1`, tok);
      if (s.rateLimited) { const until = scheduleRetry(state, s.retryAfter); await save(cp.id, state, { note: `rate-limited; ${processed} done this run` }); return json({ ok: true, waiting: true, until, processed }); }
      albumId = s.data?.albums?.items?.[0]?.id ?? null;
      await sleep(THROTTLE_MS);
    }
    if (!albumId && isrc) {
      const s = await sfetch(`https://api.spotify.com/v1/search?q=isrc:${encodeURIComponent(isrc)}&type=track&limit=1`, tok);
      if (s.rateLimited) { const until = scheduleRetry(state, s.retryAfter); await save(cp.id, state, { note: `rate-limited; ${processed} done this run` }); return json({ ok: true, waiting: true, until, processed }); }
      albumId = s.data?.tracks?.items?.[0]?.album?.id ?? null;
      await sleep(THROTTLE_MS);
    }

    // 2) fetch album label + copyrights
    let label: string | null = null, cr: string | null = null;
    if (albumId) {
      const a = await sfetch(`https://api.spotify.com/v1/albums/${albumId}`, tok);
      if (a.rateLimited) { const until = scheduleRetry(state, a.retryAfter); await save(cp.id, state, { note: `rate-limited; ${processed} done this run` }); return json({ ok: true, waiting: true, until, processed }); }
      label = a.data?.label ?? null;
      cr = (a.data?.copyrights ?? []).map((c: any) => c.text).join(' | ') || null;
      await sleep(THROTTLE_MS);
    }

    await admin.from('releases').update({ label, copyright: cr, spotify_album_id: albumId, label_checked_at: new Date().toISOString() }).eq('id', r.id);
    processed++;
  }
  state.backoff = 0; state.next_attempt_at = null;
  await save(cp.id, state, { note: `checked ${processed} this run` });

  const { count: remaining } = await admin.from('releases').select('id', { count: 'exact', head: true }).is('label_checked_at', null).eq('tier', 1);
  if ((remaining ?? 0) > 0) return json({ ok: true, done: false, processed, remaining });

  // 3) Complete — compute the §2 finding from the DB (real, durable).
  const { data: all } = await admin.from('releases').select('title, release_date, label, copyright').eq('tier', 1).not('label_checked_at', 'is', null);
  const checked = (all ?? []).filter((r) => r.spotify_album_id !== undefined); // all checked
  const withAlbum = (all ?? []).filter((r) => (r.label ?? '') || (r.copyright ?? ''));
  const svr = (all ?? []).filter((r) => SVR.test(`${r.label ?? ''} ${r.copyright ?? ''}`));

  await admin.from('silk_task_checkpoints').update({ status: 'done', note: `${svr.length}/${withAlbum.length} SVR (${(all ?? []).length} checked)`, updated_at: new Date().toISOString() }).eq('id', cp.id);
  await admin.from('entity_facts').delete().eq('key', '§2 label association (Spotify)');
  await admin.from('entity_facts').insert({ key: '§2 label association (Spotify)', value: `${svr.length} of ${withAlbum.length} matched releases carry "Silk Velvet Records" in Spotify label/copyright${svr.length ? ` (e.g. ${svr.slice(0, 5).map((r) => r.title).join(', ')})` : ''}. ${(all ?? []).length} releases checked.`, source: 'Spotify album label (per-release UPC/ISRC lookup)', confidence: 'verified' });
  await admin.from('silk_journal').insert({ entry: `Label sweep complete (real source): ${svr.length}/${withAlbum.length} matched releases show Silk Velvet Records as label/copyright on Spotify. Labels persisted to releases.label. ${withAlbum.length === 0 ? 'No release resolved to a Spotify album with a label — SVR is NOT set as the public label on any release.' : svr.length === 0 ? 'SVR appears on NONE — releases carry a different label (likely the distributor default).' : ''}`, tags: ['catalog', 'label-sweep', 'svr', 'finding'] });

  // Only file a §2 proposal when there's a real, actionable finding (deduped + capped).
  if (withAlbum.length > 0) {
    const filed = await fileQueueItem({ kind: 'metadata-fix', risk_tier: 'amber', maxPerDay: 1, payload: {
      title: `§2 label: ${svr.length}/${withAlbum.length} releases show Silk Velvet Records on Spotify`,
      generated_by: 'label-sweep',
      rationale: `Per-release Spotify label lookup: ${svr.length} of ${withAlbum.length} releases (of ${(all ?? []).length} checked) carry "Silk Velvet Records" in the label/copyright field. ${svr.length === 0 ? 'SVR is NOT the public label — §2 "no public association found" is accurate; consider whether to set SVR as the label on future releases.' : `Update §2 to reflect the confirmed association. Releases: ${svr.map((r) => r.title).join(', ')}.`}`,
      svr_titles: svr.map((r) => r.title),
    } });
    if (DISCORD && filed.filed) await fetch(DISCORD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🏷️ **Label sweep done** — ${svr.length}/${withAlbum.length} releases show **Silk Velvet Records** on Spotify. Details in your Workshop queue. — Silk` }) }).catch(() => {});
  }

  return json({ ok: true, done: true, checked: (all ?? []).length, with_album: withAlbum.length, svr: svr.length, svr_titles: svr.map((r) => r.title) });
});
