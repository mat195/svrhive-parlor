// site-visit — privacy-first analytics beacon for silkvelvetrecords.com.
// Public (no auth): the beacon posts { path, referrer, ua, session_id }; we
// derive host + AI-referrer flag and insert via the service role. No IP stored,
// no cookies, no fingerprinting. site_visits is owner-read-only (RLS).
// Fires a Discord ping on the first AI referrer of each calendar day.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});
const DISCORD = Deno.env.get('DISCORD_WEBHOOK_URL') ?? '';

const AI_HOSTS = [
  'chatgpt.com', 'chat.openai.com', 'perplexity.ai', 'www.perplexity.ai',
  'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'bing.com', 'www.bing.com',
];

const ALLOWED_ORIGINS = [
  'https://silkvelvetrecords.com', 'https://www.silkvelvetrecords.com',
  'https://mat195.github.io',
];

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.some((o) => origin === o) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function hostOf(url: string): string | null {
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

Deno.serve(async (req) => {
  const origin = req.headers.get('Origin');
  const headers = cors(origin);
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return new Response('no', { status: 405, headers });

  let body: { path?: string; referrer?: string; ua?: string; session_id?: string };
  try { body = await req.json(); } catch { return new Response('bad', { status: 400, headers }); }

  const refHost = body.referrer ? hostOf(body.referrer) : null;
  const isAi = !!refHost && AI_HOSTS.some((h) => refHost === h || refHost.endsWith('.' + h));
  const country = req.headers.get('cf-ipcountry') || req.headers.get('x-vercel-ip-country') || null;

  await admin.from('site_visits').insert({
    path: (body.path ?? '').slice(0, 300),
    referrer: (body.referrer ?? '').slice(0, 500) || null,
    referrer_host: refHost,
    is_ai_referrer: isAi,
    user_agent: (body.ua ?? '').slice(0, 400) || null,
    country,
    session_id: (body.session_id ?? '').slice(0, 64) || null,
  });

  // First AI referrer of the day / ever → Silk announces on Discord.
  if (isAi && DISCORD) {
    try {
      const startOfDay = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
      const { count: todayCount } = await admin
        .from('site_visits')
        .select('id', { count: 'exact', head: true })
        .eq('is_ai_referrer', true)
        .gte('ts', startOfDay);
      if ((todayCount ?? 0) <= 1) {
        const { count: everCount } = await admin
          .from('site_visits')
          .select('id', { count: 'exact', head: true })
          .eq('is_ai_referrer', true);
        const first = (everCount ?? 0) <= 1;
        const title = first ? 'FIRST AI VISITOR — EVER' : 'First AI referrer of the day';
        await fetch(DISCORD, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'Silk V1',
            embeds: [{
              title,
              description: [
                first ? 'It happened. An answer engine sent a human to us.' : 'An answer engine sent a visitor today.',
                `**Referrer:** ${refHost}`,
                `**Path:** ${body.path}`,
                '— Silk V1',
              ].join('\n'),
              color: first ? 0xffd700 : 0x2ecc71,
            }],
          }),
        });
      }
    } catch { /* notification is best-effort */ }
  }

  return new Response(JSON.stringify({ ok: true }), { headers: { ...headers, 'Content-Type': 'application/json' } });
});
