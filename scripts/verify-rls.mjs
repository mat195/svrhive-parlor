// Verify Parlor security posture:
//  1. Anon key WITHOUT a session reads ZERO rows on every table (RLS lockdown).
//  2. A non-owner email cannot sign in (signups disabled → clean failure).
// Uses only public values (URL + anon key). Run: node scripts/verify-rls.mjs
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }),
);
const url = env.VITE_SUPABASE_URL;
const anon = env.VITE_SUPABASE_ANON_KEY;
const anonClient = createClient(url, anon, { auth: { persistSession: false } });

const TABLES = [
  'visibility_runs', 'visibility_results', 'silk_journal', 'entity_facts', 'link_graph',
  'releases', 'tracks', 'mentions_ledger', 'metrics_snapshots', 'action_queue', 'drafts',
  'parlor_chats', 'parlor_messages',
  'site_visits', 'run_deltas', 'corpus_drafts', 'corpus_draft_versions',
  'listing_wizards', 'listing_progress', 'brain_positions', 'silk_focus', 'silk_questions', 'mat_answers', 'web_fetch_cache', 'web_fetches', 'silk_status',
  'grant_opportunities',
];

let ok = true;

console.log('— anon (no session) must read ZERO rows on every table —');
for (const t of TABLES) {
  const { data, error } = await anonClient.from(t).select('*').limit(5);
  const rows = data?.length ?? 0;
  const blocked = rows === 0; // RLS returns empty (not error) for no-policy anon
  console.log(`  ${blocked ? '✓' : '✗'} ${t}: ${error ? 'error ' + error.message : rows + ' rows'}`);
  if (!blocked) ok = false;
}

console.log('— non-owner email must NOT be able to sign in —');
const { error: otpErr } = await anonClient.auth.signInWithOtp({
  email: 'intruder@example.com',
  options: { shouldCreateUser: false },
});
if (otpErr) {
  console.log(`  ✓ blocked: ${otpErr.message}`);
} else {
  console.log('  ✗ non-owner OTP request was accepted (should be rejected)');
  ok = false;
}

console.log(ok ? '\nParlor security: PASS' : '\nParlor security: FAIL');
process.exit(ok ? 0 : 1);
