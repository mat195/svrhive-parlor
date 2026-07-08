// cover-art-harvest — returns the 640px Spotify cover-art URL for every release that has
// a resolved spotify_album_id (fast: batch /v1/albums?ids=, ~4 calls for the catalog).
// The caller downloads + self-hosts the images (Spotify CDN URLs rotate). Also upserts a
// cover_art row per release so the mapping is recorded.
import { admin, json, CORS } from '../_shared/auth.ts';

const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const CID = Deno.env.get('SPOTIFY_CLIENT_ID') ?? '';
const CSEC = Deno.env.get('SPOTIFY_CLIENT_SECRET') ?? '';

async function token(): Promise<string | null> {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${CID}:${CSEC}`) }, body: 'grant_type=client_credentials',
  });
  if (!r.ok) return null;
  return (await r.json()).access_token ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!CRON_KEY || req.headers.get('x-cron-key') !== CRON_KEY) return json({ error: 'unauthorized' }, 401);

  const tok = await token();
  if (!tok) return json({ error: 'spotify auth failed' }, 502);

  const { data: rels } = await admin.from('releases')
    .select('id, title, release_date, catalog_number, spotify_album_id')
    .not('spotify_album_id', 'is', null);
  const list = rels ?? [];
  const byAlbum = new Map(list.map((r) => [r.spotify_album_id as string, r]));

  // Per-album fetch (the batch /v1/albums?ids= endpoint 403s under client-credentials;
  // the single-album endpoint works — same as the label sweep). Resumable via cover_art:
  // skip releases already fetched. ~PER_RUN albums/invocation, throttled.
  const PER_RUN = 40;
  const out: any[] = [];
  let fetched = 0, rateLimited = false;
  for (const [albumId, rel] of byAlbum) {
    if (fetched >= PER_RUN) break;
    const { data: existing } = await admin.from('cover_art').select('id, source_url').eq('release_id', rel.id).maybeSingle();
    if (existing?.source_url) { continue; } // already have it — don't spend the fetch budget
    fetched++;
    const r = await fetch(`https://api.spotify.com/v1/albums/${albumId}?market=US`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 429) { rateLimited = true; break; }
    if (!r.ok) { await new Promise((s) => setTimeout(s, 150)); continue; }
    const a = await r.json();
    const url = (a.images ?? [])[0]?.url ?? null;
    if (url) {
      await admin.from('cover_art').upsert({ release_id: rel.id, slug: '', source_url: url, fetched_at: new Date().toISOString() }, { onConflict: 'release_id' });
      out.push({ id: rel.id, title: rel.title, release_date: rel.release_date, catalog_number: rel.catalog_number, image_url: url });
    }
    await new Promise((s) => setTimeout(s, 150));
  }
  const { count: done } = await admin.from('cover_art').select('id', { count: 'exact', head: true }).not('source_url', 'is', null);
  return json({ ok: true, this_run: out.length, total_done: done, of: list.length, rate_limited: rateLimited, covers: out });
});
