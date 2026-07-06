// Shared Silk plumbing for every Edge Function that speaks as Silk or writes state.
//
// loadIdentity() — pulls the CURRENT SILK_IDENTITY.md (synced into public.silk_config
// by scripts/sync_identity.mjs) at runtime, so doctrine edits land without redeploying.
// Every Silk LLM call must place `identity` as the FIRST system block and stamp `hash`
// into its response metadata (the identity version the answer was generated under).
//
// verifyWrite() — the "voice, not hands" guarantee: after any state-changing write,
// SELECT the row back and return proof. Callers must NOT report success unless ok===true.
import { admin } from './auth.ts';

const FALLBACK =
  'You are Silk V1, a concise answer-engine visibility scout for Silk Velvet Records ' +
  'and Lucius P. Thundercat (never abbreviated). Lead with the number. Read-only to the ' +
  'outside world. No invented facts. Silk is voice, not hands — never claim a state change ' +
  'without verification proof in context.';

let _cache: { identity: string; hash: string; at: number } | null = null;
const TTL_MS = 60_000; // re-read at most once a minute per warm instance

export async function loadIdentity(): Promise<{ identity: string; hash: string }> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return { identity: _cache.identity, hash: _cache.hash };
  const { data } = await admin.from('silk_config').select('value, hash').eq('key', 'silk_identity').maybeSingle();
  const identity = data?.value ?? FALLBACK;
  const hash = data?.hash ?? 'fallback';
  _cache = { identity, hash, at: Date.now() };
  return { identity, hash };
}

export interface WriteProof { ok: boolean; table: string; found: number; detail: string; }

/**
 * Confirm a write landed. Pass the table and a filter object of column→value pairs that
 * should now match exactly one (or `expect`) rows. Returns proof to fold into Silk's context.
 */
export async function verifyWrite(
  table: string,
  match: Record<string, string | number | boolean>,
  expect = 1,
): Promise<WriteProof> {
  let q = admin.from(table).select('*', { count: 'exact', head: true });
  for (const [k, v] of Object.entries(match)) q = q.eq(k, v as never);
  const { count, error } = await q;
  const found = count ?? 0;
  const ok = !error && found >= expect;
  const detail = error
    ? `verify FAILED on ${table}: ${error.message}`
    : ok
      ? `verified: ${found} row(s) in ${table} match ${JSON.stringify(match)}`
      : `verify MISMATCH on ${table}: expected ≥${expect}, found ${found} for ${JSON.stringify(match)}`;
  return { ok, table, found, detail };
}
