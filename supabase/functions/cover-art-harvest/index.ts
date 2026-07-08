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

  // Resolve covers by ISRC track-search (returns the album image inline). More reliable
  // than the stored spotify_album_id — some of those 403 (stale/region-locked). Resumable
  // via cover_art (skip releases already fetched). Tier-1 releases missing a cover.
  const { data: rels } = await admin.from('releases')
    .select('id, title, release_date, catalog_number, tier, tracks(isrc), cover_art(source_url)')
    .eq('tier', 1);
  const list = (rels ?? []) as any[];
  const missing = list.filter((r) => !(r.cover_art?.[0]?.source_url) && r.tracks?.[0]?.isrc);

  const PER_RUN = 40;
  const out: any[] = [];
  let fetched = 0, rateLimited = false;
  for (const rel of missing) {
    if (fetched >= PER_RUN) break;
    fetched++;
    const isrc = rel.tracks[0].isrc;
    const r = await fetch(`https://api.spotify.com/v1/search?q=isrc:${encodeURIComponent(isrc)}&type=track&market=US&limit=1`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 429) { rateLimited = true; break; }
    if (!r.ok) { await new Promise((s) => setTimeout(s, 150)); continue; }
    const track = (await r.json())?.tracks?.items?.[0];
    const url = (track?.album?.images ?? [])[0]?.url ?? null;
    if (url) {
      await admin.from('cover_art').upsert({ release_id: rel.id, slug: '', source_url: url, fetched_at: new Date().toISOString() }, { onConflict: 'release_id' });
      if (track?.album?.id) await admin.from('releases').update({ spotify_album_id: track.album.id }).eq('id', rel.id);
      out.push({ id: rel.id, title: rel.title, catalog_number: rel.catalog_number, image_url: url });
    }
    await new Promise((s) => setTimeout(s, 150));
  }
  const { count: done } = await admin.from('cover_art').select('id', { count: 'exact', head: true }).not('source_url', 'is', null);
  return json({ ok: true, this_run: out.length, total_done: done, of: list.length, rate_limited: rateLimited, covers: out });
});
