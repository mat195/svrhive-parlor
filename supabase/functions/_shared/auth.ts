import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const OWNER_EMAIL = 'matc195@gmail.com';
const URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

export const admin = createClient(URL, SERVICE, { auth: { persistSession: false } });

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

/** Returns the owner's user id, or a 401 Response if the caller isn't Mat. */
export async function requireOwner(req: Request): Promise<{ ok: true; userId: string } | { ok: false; res: Response }> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const uc = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
  const { data } = await uc.auth.getUser();
  if (!data?.user || data.user.email !== OWNER_EMAIL) {
    return { ok: false, res: json({ error: 'unauthorized' }, 401) };
  }
  return { ok: true, userId: data.user.id };
}
