// spotify-metrics — the authoritative, timestamped pull of LPT's Spotify metrics.
// Writes metrics_snapshots rows (a time series) AND upserts one current entity_fact so
// Silk cites ONE number instead of guessing between stale/conflicting figures.
//
//   followers, popularity  → /v1/artists/{id}  (API; costs Spotify quota)
//   monthly_listeners      → scrape open.spotify.com/artist/{id} og:description (no quota)
//
// Resilient: the scrape always runs; if the API is rate-limited (shared app quota), it
// records what it can and backfills followers on the next run. Cron-invoked daily.
import { admin, json, CORS } from '../_shared/auth.ts';

const CRON_KEY = Deno.env.get('CRON_KEY') ?? '';
const CID = Deno.env.get('SPOTIFY_CLIENT_ID') ?? '';
const CSEC = Deno.env.get('SPOTIFY_CLIENT_SECRET') ?? '';
const DISCORD = Deno.env.get('DISCORD_WEBHOOK_URL') ?? '';
const LPT = '2lhuyLLQPcfoXSwcNaXuF1';
const FACT_KEY = 'Spotify metrics (live)';

async function token(): Promise<string | null> {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Basic ' + btoa(`${CID}:${CSEC}`) }, body: 'grant_type=client_credentials',
  });
  if (!r.ok) return null;
  return (await r.json()).access_token ?? null;
}

// Scrape monthly listeners from the public artist page (not in the Web API).
async function scrapeMonthlyListeners(): Promise<number | null> {
  try {
    const r = await fetch(`https://open.spotify.com/artist/${LPT}`, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SVRHive/1.0)' } });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/([\d.,]+)\s*monthly listeners/i);
    if (!m) return null;
    const n = parseInt(m[1].replace(/[.,]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

async function latest(metric: string): Promise<number | null> {
  const { data } = await admin.from('metrics_snapshots').select('value').eq('platform', 'spotify').eq('metric', metric).order('captured_at', { ascending: false }).limit(1).maybeSingle();
  return data ? Number(data.value) : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (!CRON_KEY || req.headers.get('x-cron-key') !== CRON_KEY) return json({ error: 'unauthorized' }, 401);

  const prevListeners = await latest('monthly_listeners');
  const prevFollowers = await latest('followers');

  // 1) Monthly listeners — page scrape, always attempted (no API quota).
  const monthlyListeners = await scrapeMonthlyListeners();

  // 2) Followers + popularity — Web API; tolerate rate limits (backfill next run).
  let followers: number | null = null, popularity: number | null = null, apiRateLimited = false;
  const tok = await token();
  if (tok) {
    const r = await fetch(`https://api.spotify.com/v1/artists/${LPT}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 429) apiRateLimited = true;
    else if (r.ok) { const a = await r.json(); followers = a?.followers?.total ?? null; popularity = a?.popularity ?? null; }
  }

  // 3) Persist every metric we obtained (time series).
  const rows: { platform: string; metric: string; value: number }[] = [];
  if (monthlyListeners != null) rows.push({ platform: 'spotify', metric: 'monthly_listeners', value: monthlyListeners });
  if (followers != null) rows.push({ platform: 'spotify', metric: 'followers', value: followers });
  if (popularity != null) rows.push({ platform: 'spotify', metric: 'popularity', value: popularity });
  if (rows.length) await admin.from('metrics_snapshots').insert(rows);

  // 4) Upsert ONE current authoritative fact (delete-prior → insert), so Silk quotes a
  //    single sourced number with a date instead of reconciling conflicting figures.
  const nowIso = new Date().toISOString();
  const parts: string[] = [];
  if (monthlyListeners != null) parts.push(`${monthlyListeners.toLocaleString('en-US')} monthly listeners`);
  if (followers != null) parts.push(`${followers.toLocaleString('en-US')} followers`);
  if (popularity != null) parts.push(`popularity ${popularity}/100`);
  if (parts.length) {
    await admin.from('entity_facts').delete().eq('key', FACT_KEY);
    await admin.from('entity_facts').insert({ key: FACT_KEY, value: `Spotify: ${parts.join(', ')} (as of ${nowIso.slice(0, 10)}). Source: live Spotify pull. This is the authoritative current figure — prefer it over any older number.`, source: 'spotify-metrics pull', confidence: 'verified' });
  }

  // 5) Notable-change Discord ping (low-noise): first-ever pull, or listeners moved ≥5%.
  const notable =
    (monthlyListeners != null && prevListeners == null) ||
    (monthlyListeners != null && prevListeners != null && prevListeners > 0 && Math.abs(monthlyListeners - prevListeners) / prevListeners >= 0.05);
  if (DISCORD && notable && monthlyListeners != null) {
    const delta = prevListeners != null ? monthlyListeners - prevListeners : null;
    const arrow = delta == null ? '' : delta > 0 ? ` (▲${delta})` : ` (▼${Math.abs(delta)})`;
    await fetch(DISCORD, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `🎧 **Spotify** — Lucius P. Thundercat now at **${monthlyListeners.toLocaleString('en-US')} monthly listeners**${arrow}${followers != null ? `, ${followers.toLocaleString('en-US')} followers` : ''}. — Silk` }) }).catch(() => {});
  }

  return json({
    ok: true,
    captured: rows.map((r) => r.metric),
    monthly_listeners: monthlyListeners, followers, popularity,
    prev: { monthly_listeners: prevListeners, followers: prevFollowers },
    api_rate_limited: apiRateLimited,
  });
});
