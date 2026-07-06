// web-fetch — Silk's research infrastructure. GET-only, allowlisted, cached,
// rate-limited, robots-aware, fully audited. Owner-only (same pattern as
// silk-chat). NEVER performs POST/PUT/DELETE/PATCH — read-only to the world.
//
// Returns { url, status, headers, body, fetched_at, from_cache }.
import { admin, requireOwner, json, CORS } from '../_shared/auth.ts';

const UA = 'SilkV1Bot/1.0 (+https://silkvelvetrecords.com; research; contact via silkvelvetrecords.com)';
const MIN_HOST_GAP_MS = 1200;      // politeness: min delay between hits to a host
const MAX_BODY = 900_000;          // cap cached body size
const DEFAULT_TTL = 86_400;        // 24h

// Allowlist — hardcoded default, overridable via WEB_FETCH_ALLOWLIST env (CSV).
const DEFAULT_ALLOW = [
  'open.spotify.com', 'api.spotify.com', 'soundcloud.com', 'bandcamp.com',
  'musicbrainz.org', 'wikidata.org', 'genius.com', 'ws.audioscrobbler.com',
  'last.fm', 'youtube.com', 'www.googleapis.com',
];
function allowlist(): string[] {
  const env = (Deno.env.get('WEB_FETCH_ALLOWLIST') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return env.length ? env : DEFAULT_ALLOW;
}
function hostAllowed(host: string, allow: string[]): boolean {
  return allow.some((d) => host === d || host.endsWith('.' + d));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getCache(url: string) {
  const { data } = await admin.from('web_fetch_cache').select('*').eq('url', url).maybeSingle();
  if (!data) return null;
  const age = (Date.now() - Date.parse(data.fetched_at)) / 1000;
  return age < (data.ttl_seconds ?? DEFAULT_TTL) ? data : null;
}
async function putCache(url: string, status: number, headers: Record<string, string>, body: string) {
  await admin.from('web_fetch_cache').upsert(
    { url, status, headers, body: body.slice(0, MAX_BODY), fetched_at: new Date().toISOString(), ttl_seconds: DEFAULT_TTL },
    { onConflict: 'url' },
  );
}
async function audit(url: string, host: string, status: number, fromCache: boolean) {
  await admin.from('web_fetches').insert({ url, host, status, from_cache: fromCache });
}

/** Best-effort robots.txt gate. Fails open if robots is unreachable. */
async function robotsAllows(origin: string, path: string): Promise<boolean> {
  const robotsUrl = `${origin}/robots.txt`;
  let txt = '';
  const cached = await admin.from('web_fetch_cache').select('body, fetched_at, ttl_seconds').eq('url', robotsUrl).maybeSingle();
  if (cached.data && (Date.now() - Date.parse(cached.data.fetched_at)) / 1000 < (cached.data.ttl_seconds ?? DEFAULT_TTL)) {
    txt = cached.data.body ?? '';
  } else {
    try {
      const r = await fetch(robotsUrl, { headers: { 'User-Agent': UA } });
      txt = r.ok ? await r.text() : '';
      await putCache(robotsUrl, r.status, {}, txt);
    } catch { return true; } // fail open
  }
  if (!txt) return true;
  // Collect Disallow rules for groups matching '*' or our bot.
  const lines = txt.split('\n').map((l) => l.replace(/#.*/, '').trim());
  let applies = false;
  const disallows: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(user-agent|disallow):\s*(.*)$/i);
    if (!m) continue;
    const [, key, val] = m;
    if (key.toLowerCase() === 'user-agent') applies = val === '*' || /silkv1bot/i.test(val);
    else if (applies && val) disallows.push(val);
  }
  return !disallows.some((d) => path.startsWith(d));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const auth = await requireOwner(req);
  if (!auth.ok) return auth.res;

  let body: { url?: string };
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const raw = (body.url ?? '').trim();
  if (!raw) return json({ error: 'url required' }, 400);

  let u: URL;
  try { u = new URL(raw); } catch { return json({ error: 'invalid url' }, 400); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return json({ error: 'only http(s)' }, 400);
  const host = u.hostname.toLowerCase();
  const allow = allowlist();
  if (!hostAllowed(host, allow)) return json({ error: `host not allowlisted: ${host}`, allowlist: allow }, 403);

  // 1. cache first
  const cached = await getCache(u.toString());
  if (cached) {
    await audit(u.toString(), host, cached.status, true);
    return json({ url: u.toString(), status: cached.status, headers: cached.headers, body: cached.body, fetched_at: cached.fetched_at, from_cache: true });
  }

  // 2. robots.txt
  if (!(await robotsAllows(u.origin, u.pathname))) {
    await audit(u.toString(), host, 999, false);
    return json({ url: u.toString(), status: 999, headers: {}, body: '', fetched_at: new Date().toISOString(), from_cache: false, note: 'blocked by robots.txt' });
  }

  // 3. politeness: space out same-host requests
  const last = await admin.from('web_fetches').select('requested_at').eq('host', host).order('requested_at', { ascending: false }).limit(1);
  const lastAt = last.data?.[0]?.requested_at ? Date.parse(last.data[0].requested_at) : 0;
  const gap = Date.now() - lastAt;
  if (lastAt && gap < MIN_HOST_GAP_MS) await sleep(Math.min(MIN_HOST_GAP_MS - gap, 2000));

  // 4. GET (retry once with backoff)
  let status = 0, text = '', hdrs: Record<string, string> = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(u.toString(), { method: 'GET', headers: { 'User-Agent': UA, Accept: 'text/html,application/json,*/*' }, redirect: 'follow' });
      status = res.status;
      hdrs = { 'content-type': res.headers.get('content-type') ?? '', 'content-length': res.headers.get('content-length') ?? '' };
      text = await res.text();
      if (res.status < 500) break;
    } catch (e) {
      status = 0; text = `[fetch error: ${e instanceof Error ? e.message : e}]`;
    }
    if (attempt === 0) await sleep(900);
  }

  await putCache(u.toString(), status, hdrs, text);
  await audit(u.toString(), host, status, false);
  return json({ url: u.toString(), status, headers: hdrs, body: text.slice(0, MAX_BODY), fetched_at: new Date().toISOString(), from_cache: false });
});
