// check-rls — CI gate (Brief Seven discipline). Silent RLS blocks present as
// success but change nothing, so every table created in a migration MUST also
// enable row level security AND declare at least one policy. Fails the build
// otherwise. Static analysis of supabase/migrations/*.sql — no DB access needed.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'migrations');
const sql = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(resolve(DIR, f), 'utf8')).join('\n').toLowerCase();

const tables = new Set();
for (const m of sql.matchAll(/create table\s+(?:if not exists\s+)?(?:public\.)?(\w+)/g)) tables.add(m[1]);

const rlsOn = new Set();
for (const m of sql.matchAll(/alter table\s+(?:if exists\s+)?(?:only\s+)?(?:public\.)?(\w+)\s+enable row level security/g)) rlsOn.add(m[1]);

const hasPolicy = new Set();
for (const m of sql.matchAll(/create policy\s+[\w-]+\s+on\s+(?:public\.)?(\w+)/g)) hasPolicy.add(m[1]);

const violations = [];
for (const t of tables) {
  if (!rlsOn.has(t)) violations.push(`${t}: no "enable row level security"`);
  else if (!hasPolicy.has(t)) violations.push(`${t}: RLS enabled but NO policy declared`);
}

if (violations.length) {
  console.error('✗ RLS check FAILED — every created table needs RLS + at least one policy:');
  for (const v of violations) console.error('  • ' + v);
  console.error('\nSilent RLS blocks report success while changing nothing. Add the owner policy.');
  process.exit(1);
}
console.log(`✓ RLS check passed — ${tables.size} tables, all with RLS + policies.`);
